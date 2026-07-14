/**
 * DeploymentsView.jsx — Deployments-Panel (Capability B, ADR-012).
 *
 * Spec: deploy-lifecycle.md AC3–AC9, AC10–AC14 (S-155), AC15
 *       stack-deploy-orchestration.md AC12 (Modus-Umschalter)
 *       vps-readiness-gate.md AC9–AC12 (S-181)
 *       vps-tunnel-existence-gate.md AC8–AC11 (S-186)
 *       vps-tunnel-self-heal.md AC9–AC10 (S-188)
 *       per-app-gpg-passphrase-provisioning.md AC7/AC8 (F-073/S-337)
 *       per-app-gpg-passphrase-rotation.md AC8/AC9 (F-073/S-339)
 *       deploy-bitwarden-gpg-injection.md AC16 (F-073/S-340)
 *       deploy-config-volume-mount.md AC9 (F-078/S-348)
 *
 * Responsibilities:
 *   - GPG-Passphrasen-Provisionierung je App (per-app-gpg-passphrase-provisioning.md
 *     AC7/AC8, F-073/S-337): Knopf je in GET /api/github/packages gelisteter App —
 *     POST /api/deployments/:app/gpg-provision (bestehender AccessGuard+CRED_ADMIN-
 *     Endpunkt, S-335). Quittung geheimnisfrei: nur `created`|`already-exists`|
 *     `access-not-ready`|`failed` (+ Klartext-Hinweis) — NIE die Passphrase; die
 *     Response enthält per Vertrag kein weiteres Feld.
 *   - GPG-Passphrasen-Rotation je App (per-app-gpg-passphrase-rotation.md AC8/AC9,
 *     F-073/S-339): zweistufige Quittung (Muster Backup-Settings [[credential-backup]])
 *     gegen die bestehenden, hinter AccessGuard+CRED_ADMIN geschützten Endpunkte
 *     (S-338) — POST .../gpg-rotate/start (Stufe 1: Kandidat + Beweis-Runde),
 *     POST .../gpg-rotate/commit (Stufe 2: umschalten). Bleibt eine Stufe aus/
 *     fehlerhaft, erscheint eine stufen-genaue Warnung statt grüner Quittung.
 *     Der Rollback-Anker-Aufräum-Knopf (POST .../gpg-rotate/discard-previous) ist
 *     eine GETRENNTE, explizit bestätigte Aktion (type-to-confirm, Muster Undeploy-
 *     Dialog dieser Datei) — deaktiviert, bis Stufe 2 dieser Session erfolgreich war
 *     UND der Nutzer selbst bestätigt hat, dass ein Deploy mit der neuen Passphrase
 *     durchgelaufen ist (kein Backend-Signal dafür vorhanden — reine UI-Bestätigung,
 *     AC9). Response geheimnisfrei (`{ok, phase?, errorClass?, reason?}`) — nie eine
 *     Passphrase, nie `.env.gpg`-Klartext.
 *   - Mode toggle: "Single-Image" | "Compose-Stack aus Repo" (AC12)
 *   - Single-Image mode (deploy-lifecycle.md AC10–AC14):
 *       List live deployments (Container↔Route as unit) — GET /api/deployments
 *       Deploy form — GUIDED DROPDOWNS (AC10):
 *         Image-Dropdown (GET /api/github/packages)
 *         Tag-Dropdown   (GET /api/github/packages/:name/tags, disabled until image chosen)
 *         VPS-Dropdown   (GET /api/deployments/vps-targets, incl. tunnelIds map)
 *         Domain-Dropdown (GET /api/cloudflare/zones)
 *         Subdomain field: pre-filled from image name (AC11), editable; shows assembled hostname
 *         Deploy-Button: active only when Image+Tag+VPS+Domain+Subdomain non-empty (AC12)
 *                        + VPS ready (vpsReadiness==='ready', S-181 AC10)
 *                        + Tunnel present (tunnelPresent===true, S-186 AC10)
 *         POST /api/deployments { image: "fullRef:tag", vps, hostname: "sub.domain", tunnelId }
 *         tunnelId: derived from VPS↔Tunnel-Read-Model (S-186 AC8), not from zone-tunnel dropdown
 *         Auto-Port: resolved server-side via docker inspect after pull (AC13)
 *         Re-Deploy: existing deploy on same hostname is replaced; UI shows "replaces existing" (AC14)
 *       Undeploy with type-to-confirm → DELETE /api/deployments/:vps/:hostname (AC5/AC6)
 *       Show 422/protected-resource / 422/confirmation-required clearly (no secrets) (AC7)
 *   - Compose-Stack mode (AC12):
 *       List stacks from registry — GET /api/deployments/stacks
 *       Deploy stack — POST /api/deployments/stacks/{stackName}/deploy
 *       Undeploy stack with type-to-confirm — DELETE /api/deployments/stacks/{stackName}/undeploy
 *       Stack status with drift flags — GET /api/deployments/stacks/{stackName}/status
 *   - No Cloudflare token or SSH key in frontend bundle (AC9/AC15/security, S-186 AC12)
 *
 * VPS↔Tunnel-Kopplung (S-186 AC8–AC10):
 *   - GET /api/deployments/vps-targets returns { vpsIds, tunnelIds: { vpsId: tunnelId|null } }
 *   - GET /api/deployments/vps-tunnel-status returns [{vpsId, tunnelId, tunnelPresent}] (polled)
 *   - Tunnel-Badge shows "Tunnel ✓" / "Tunnel fehlt ✗" (AC9); no badge without VPS selection
 *   - Deploy-Button blocked when tunnelPresent !== true (AC10)
 *   - formatReason() maps tunnel-missing / tunnel-mismatch (AC11)
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
 *   - No token/key displayed or bundled (AC12 S-186: tunnelId is non-secret; tunnelToken never)
 *   - Error messages from backend are rendered as text (no innerHTML)
 *
 * GPG-Bitwarden-Item-Default (deploy-bitwarden-gpg-injection.md AC16, F-073/S-340):
 *   - Deploy-Formular leitet gpgBwItem-Default als "env.gpg-passphrase-<selectedPackage>"
 *     ab (deriveGpgBwItem) und sendet ihn im POST /api/deployments-Body mit.
 *   - Feld ist überschreibbar; sobald der Nutzer manuell editiert (gpgBwItemTouched),
 *     folgt der Wert dem Slug-Wechsel NICHT mehr (kein Default-Reset über die manuelle
 *     Eingabe hinweg).
 *
 * config.yaml-Mount (deploy-config-volume-mount.md AC9, F-078/S-348):
 *   - Checkbox „config.yaml auf dem VPS bereitstellen (read-only nach /app/config.yaml
 *     gemountet)"; aktiv → zusätzliches optionales mehrzeiliges Seed-Feld (Erst-Deploy-
 *     Inhalt) + read-only Vorschau des Host-Pfads `~/apps/<configApp>/config.yaml`.
 *   - configApp-Default wird wie gpgBwItem/Subdomain aus dem gewählten Image/Package
 *     abgeleitet (deriveSubdomain), bleibt editierbar; folgt dem Slug-Wechsel nicht mehr,
 *     sobald manuell editiert (configAppTouched).
 *   - Checkbox inaktiv → requiresConfig/configApp/configSeed werden NICHT gesendet
 *     (unveränderter Request, AC9).
 */

import { useState, useEffect, useRef, useCallback } from 'react';

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

/** Poll interval for VPS readiness check (AC9/AC11 — NFR: ~3s). */
const READINESS_POLL_MS = 3000;

/** Poll interval for Tunnel-Existenz-Check (S-186 AC9 — NFR: moderate, ~5s). */
const TUNNEL_STATUS_POLL_MS = 5000;

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

/**
 * Derive the default Bitwarden-Item-Name for the per-App-GPG-Passphrase from the
 * selected target slug (deploy-bitwarden-gpg-injection.md AC15/AC16).
 * e.g. "brew-assistent" → "env.gpg-passphrase-brew-assistent"
 *
 * @param {string} slug
 * @returns {string}
 */
function deriveGpgBwItem(slug) {
  if (!slug) return '';
  return `env.gpg-passphrase-${slug}`;
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
  // S-186 AC8: tunnelIds map from vps-targets { vpsId: tunnelId|null }
  const [tunnelIdsByVps, setTunnelIdsByVps] = useState({}); // { [vpsId]: tunnelId|null }
  const [zones, setZones] = useState([]);               // [{ id, name }]
  const [zonesState, setZonesState] = useState('idle');

  // ── AC10–AC12: Guided deploy form state
  const [selectedPackage, setSelectedPackage] = useState(''); // package name (e.g. "brew-assistent")
  const [selectedTag, setSelectedTag] = useState('');          // tag string (e.g. "v1.2.0")
  const [selectedVps, setSelectedVps] = useState('');          // vps id
  const [selectedZone, setSelectedZone] = useState('');        // zone name (e.g. "alexstuder.cloud")
  // Note: zone-based tunnel dropdown removed by S-186 AC8 — tunnelId now derived from VPS-linked Read-Model
  const [subdomain, setSubdomain] = useState('');              // AC11: editable subdomain
  // F-073/S-340 AC16: gpgBwItem-Default "env.gpg-passphrase-<slug>", überschreibbar.
  // gpgBwItemTouched: sobald true, überschreibt der Slug-Wechsel den Wert NICHT mehr.
  const [gpgBwItem, setGpgBwItem] = useState('');
  const [gpgBwItemTouched, setGpgBwItemTouched] = useState(false);
  // deploy-config-volume-mount AC9 (F-078/S-348): config.yaml-Mount-Checkbox +
  // Seed-Feld + configApp-Default (gleiche Ableitung wie gpgBwItem/Subdomain).
  const [requiresConfig, setRequiresConfig] = useState(false);
  const [configApp, setConfigApp] = useState('');
  const [configAppTouched, setConfigAppTouched] = useState(false);
  const [configSeed, setConfigSeed] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null); // { ok, message, replaced? }

  // Undeploy
  const [undeployState, setUndeployState] = useState(null); // null | INITIAL_UNDEPLOY_STATE
  const [undeploying, setUndeploying] = useState(false);
  const [undeployResult, setUndeployResult] = useState(null); // { ok, message }

  // ── S-156: Lokal-Test state
  const [localTesting, setLocalTesting] = useState(false);
  const [localTestResult, setLocalTestResult] = useState(null); // { ok, report?, reason? }

  // ── AC9/AC10/AC11: VPS Readiness polling ─────────────────────────────────
  // 'unknown' = not yet polled; 'unreachable'|'provisioning'|'ready' = from API
  const [vpsReadiness, setVpsReadiness] = useState('unknown');
  const readinessTimerRef = useRef(null);

  // ── S-186 AC9/AC10: Tunnel-Existenz-Status polling ───────────────────────
  // null = no VPS selected / not yet polled; true/false/null = tunnelPresent; 'unknown' = CF unavailable
  // tunnelPresent: true → "Tunnel ✓"; false / 'unknown' / null → "Tunnel fehlt ✗"
  const [tunnelPresent, setTunnelPresent] = useState(null); // null | boolean | 'unknown'
  const tunnelTimerRef = useRef(null);

  // ── S-188 AC9/AC10: Tunnel-Selbstheilung (Ein-Klick-Knopf) ──────────────
  // tunnelHealState: null = idle; 'running' = Lauf läuft; 'done' = Ergebnis vorhanden
  const [tunnelHealState, setTunnelHealState] = useState(null); // null | 'running' | 'done'
  const [tunnelHealResult, setTunnelHealResult] = useState(null); // null | { ok, report?, errorMsg? }
  // tunnelPollCounter: inkrementiert nach erfolgreichem Heal → triggert Neupoll
  const [tunnelPollCounter, setTunnelPollCounter] = useState(0);

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

  // ── F-073/S-337 AC7/AC8: Nach-Provisionierung GPG-Passphrase je App ──────
  // Keyed by App-Slug (packages[].name). Response ist per Vertrag geheimnisfrei
  // (nur { result, reason? }) — es wird NIE ein Passphrasen-Wert im State gehalten.
  const [gpgProvisionState, setGpgProvisionState] = useState({}); // { [app]: { loading, result, reason, errorMsg } }

  // ── F-073/S-339 AC8/AC9: Per-App-GPG-Passphrase-Rotation (zweistufige Quittung
  // + Rollback-Anker-Aufräum-Knopf) ─────────────────────────────────────────────
  // Keyed by App-Slug. Response ist geheimnisfrei ({ ok, phase?, errorClass?,
  // reason? }) — nie ein Passphrasen-Wert im State. `rotationCompleted`/
  // `deployConfirmed` sind reine UI-Zustände (kein Backend-Signal existiert für
  // "Deploy mit neuer Passphrase bestätigt" — AC9 verlangt genau deshalb die
  // getrennte, explizite Nutzer-Bestätigung).
  const [gpgRotationState, setGpgRotationState] = useState({});
  // { [app]: {
  //     starting, startResult: {ok, phase, errorClass?, reason?} | null,
  //     committing, commitResult: {ok, errorClass?, reason?} | null,
  //     rotationCompleted: boolean,   // true nach commitResult.ok === true (diese Session)
  //     deployConfirmed: boolean,     // Selbst-Bestätigung "Deploy mit neuer Passphrase durchgelaufen"
  //     discardConfirmText: string,   // type-to-confirm (App-Name)
  //     discarding, discardResult: {ok, errorClass?, reason?} | null,
  // } }

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

  // Load VPS IDs (S-186 AC8: also loads tunnelIds map for VPS↔Tunnel-Kopplung)
  useEffect(() => {
    if (vpsIdsState !== 'idle') return;
    setVpsIdsState('loading');
    fetch('/api/deployments/vps-targets')
      .then((r) => r.json())
      .then((d) => {
        setVpsIds(d.vpsIds ?? []);
        // S-186 AC8: tunnelIds map { vpsId: tunnelId|null } — non-secret, no token
        setTunnelIdsByVps(d.tunnelIds ?? {});
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

  // ── S-186 AC8: Zone-based tunnel dropdown removed.
  // Tunnel-Id is now derived from the VPS↔Tunnel-Read-Model (vpsLinkedTunnelId).
  // The zone-per-tunnel load effect is no longer needed.

  // ── AC11: Pre-fill subdomain from selected image name ───────────────────
  useEffect(() => {
    if (selectedPackage) {
      setSubdomain(deriveSubdomain(selectedPackage));
    } else {
      setSubdomain('');
    }
  }, [selectedPackage]);

  // ── F-073/S-340 AC16: Pre-fill gpgBwItem from selected target slug ───────
  // Follows the slug only while untouched (gpgBwItemTouched === false); a manual
  // edit is never overwritten by a subsequent slug change.
  useEffect(() => {
    if (gpgBwItemTouched) return;
    setGpgBwItem(deriveGpgBwItem(selectedPackage));
  }, [selectedPackage, gpgBwItemTouched]);

  // ── deploy-config-volume-mount AC9 (F-078/S-348): Pre-fill configApp from the
  // same slug as gpgBwItem/Subdomain. Follows the slug only while untouched.
  useEffect(() => {
    if (configAppTouched) return;
    setConfigApp(deriveSubdomain(selectedPackage));
  }, [selectedPackage, configAppTouched]);

  // ── AC9/AC11: VPS Readiness polling ─────────────────────────────────────
  // Poll GET /api/deployments/readiness?vps=<selectedVps> periodically.
  // Stops when 'ready' is reached (AC11). Clears timer on unmount or VPS change.
  useEffect(() => {
    // Helper to stop any running timer
    function clearTimer() {
      if (readinessTimerRef.current !== null) {
        clearInterval(readinessTimerRef.current);
        readinessTimerRef.current = null;
      }
    }

    // No VPS selected → no badge, no poll (AC9)
    if (!selectedVps) {
      clearTimer();
      setVpsReadiness('unknown');
      return;
    }

    // Reset state for new VPS selection
    setVpsReadiness('unknown');
    clearTimer();

    let active = true; // prevent state update after cleanup

    async function poll() {
      try {
        const res = await fetch(
          `/api/deployments/readiness?vps=${encodeURIComponent(selectedVps)}`,
        );
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          const state = data?.state;
          if (!active) return;
          setVpsReadiness(state ?? 'unknown');
          // AC11: stop polling once ready
          if (state === 'ready') {
            clearTimer();
          }
        }
        // On non-ok response: leave current readiness state unchanged, keep polling
      } catch {
        // Network error: leave state, keep polling
      }
    }

    // Immediate first poll, then interval
    poll();
    readinessTimerRef.current = setInterval(poll, READINESS_POLL_MS);

    return () => {
      active = false;
      clearTimer();
    };
  }, [selectedVps]); // dep: selectedVps only — clearTimer/poll/readinessTimerRef are stable refs

  // ── S-186 AC9/AC10: Tunnel-Existenz-Status polling ───────────────────────
  // Polls GET /api/deployments/vps-tunnel-status and extracts tunnelPresent for selectedVps.
  // Analog zum VPS-Readiness-Polling (S-181 AC9/AC11).
  // Stops when tunnelPresent === true (Tunnel existiert — Badge "Tunnel ✓").
  useEffect(() => {
    function clearTunnelTimer() {
      if (tunnelTimerRef.current !== null) {
        clearInterval(tunnelTimerRef.current);
        tunnelTimerRef.current = null;
      }
    }

    // No VPS selected → no tunnel badge (AC9); reset heal state (S-188)
    if (!selectedVps) {
      clearTunnelTimer();
      setTunnelPresent(null);
      setTunnelHealState(null);
      setTunnelHealResult(null);
      return;
    }

    // Reset tunnel status on new VPS selection
    setTunnelPresent(null);
    clearTunnelTimer();

    let active = true;

    async function poll() {
      try {
        const res = await fetch('/api/deployments/vps-tunnel-status');
        if (!active) return;
        if (res.ok) {
          const data = await res.json();
          if (!active) return;
          // Find the entry for the currently selected VPS
          const entry = Array.isArray(data) ? data.find((e) => e.vpsId === selectedVps) : null;
          const present = entry ? entry.tunnelPresent : false;
          setTunnelPresent(present);
          // Stop polling once tunnel is confirmed present
          if (present === true) {
            clearTunnelTimer();
          }
        }
        // On non-ok response: leave state, keep polling
      } catch {
        // Network error: keep polling
      }
    }

    // Immediate first poll, then interval
    poll();
    tunnelTimerRef.current = setInterval(poll, TUNNEL_STATUS_POLL_MS);

    return () => {
      active = false;
      clearTunnelTimer();
    };
  }, [selectedVps, tunnelPollCounter]); // tunnelPollCounter re-triggers after successful heal (S-188)

  // ── S-186 AC8: Derive effective tunnelId from VPS selection ──────────────
  // The tunnelId used in the deploy POST comes from the VPS↔Tunnel-Read-Model
  // (not from the zone-based tunnel dropdown). Non-secret: tunnelId may be shown.
  const vpsLinkedTunnelId = selectedVps ? (tunnelIdsByVps[selectedVps] ?? null) : null;

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
  // AC10 (vps-readiness-gate): additionally requires vpsReadiness === 'ready'
  // S-186 AC10: additionally requires tunnelPresent === true
  const canDeploy =
    !deploying &&
    selectedPackage !== '' &&
    selectedTag !== '' &&
    selectedVps !== '' &&
    selectedZone !== '' &&
    subdomain.trim() !== '' &&
    vpsReadiness === 'ready' &&
    tunnelPresent === true;

  // ── S-156: Lokal-Test handler ────────────────────────────────────────────
  async function handleLocalTest(e) {
    e.preventDefault();
    if (!selectedPackage || !selectedTag) return;
    setLocalTesting(true);
    setLocalTestResult(null);
    const imageWithTag = fullImageRef;
    try {
      const res = await fetch('/api/deployments/local-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageWithTag, tag: selectedTag }),
      });
      const data = await res.json();
      if (res.ok && data.result === 'ok') {
        setLocalTestResult({ ok: true, report: data.report });
      } else {
        const reason = data?.reason ?? data?.error ?? 'Lokal-Test fehlgeschlagen';
        setLocalTestResult({ ok: false, reason: String(reason).slice(0, 200) });
      }
    } catch {
      setLocalTestResult({ ok: false, reason: 'Netzwerkfehler beim Lokal-Test' });
    } finally {
      setLocalTesting(false);
    }
  }

  // ── S-188 AC9/AC10: Tunnel-Selbstheilung handler ────────────────────────
  // Ruft POST /api/deployments/vps/:vpsId/tunnel/recreate auf.
  // Security: Token NIE in Frontend/UI/Log (AC11).
  async function handleTunnelHeal() {
    if (!selectedVps || tunnelHealState === 'running') return;
    setTunnelHealState('running');
    setTunnelHealResult(null);
    try {
      const res = await fetch(
        `/api/deployments/vps/${encodeURIComponent(selectedVps)}/tunnel/recreate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      const data = await res.json();
      if (res.ok && (data.result === 'ok' || data.result === 'partial')) {
        setTunnelHealResult({ ok: data.result === 'ok', report: data.report, partial: data.result === 'partial' });
        // Aktualisierung: Tunnel-Status neu pollen (Badge soll auf "Tunnel ✓" wechseln)
        // tunnelPollCounter-Increment triggert das Polling-useEffect neu
        setTunnelPresent(null);
        setTunnelPollCounter((c) => c + 1);
      } else {
        const errorMsg = formatTunnelHealError(data);
        setTunnelHealResult({ ok: false, errorMsg });
      }
    } catch {
      setTunnelHealResult({ ok: false, errorMsg: 'Netzwerkfehler beim Tunnel-Neu-Anlegen' });
    } finally {
      setTunnelHealState('done');
    }
  }

  // ── F-073/S-337 AC7: Nach-Provisionierung GPG-Passphrase je App ─────────
  // Ruft POST /api/deployments/:app/gpg-provision auf (bestehender, hinter
  // AccessGuard+CRED_ADMIN geschützter Endpunkt, S-335). AC8: nur { result,
  // reason? } wird aus der Response übernommen — nie ein weiteres Feld (kein
  // Passphrasen-Wert landet je im UI-State).
  async function handleGpgProvision(appName) {
    if (!appName || gpgProvisionState[appName]?.loading) return;
    setGpgProvisionState((s) => ({
      ...s,
      [appName]: { loading: true, result: null, reason: null, errorMsg: null },
    }));
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(appName)}/gpg-provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (res.ok && typeof data?.result === 'string') {
        setGpgProvisionState((s) => ({
          ...s,
          [appName]: {
            loading: false,
            result: data.result,
            reason: typeof data.reason === 'string' ? data.reason : null,
            errorMsg: null,
          },
        }));
      } else {
        const errorMsg =
          typeof data?.error === 'string' ? data.error
          : typeof data?.reason === 'string' ? data.reason
          : 'GPG-Provisionierung fehlgeschlagen';
        setGpgProvisionState((s) => ({
          ...s,
          [appName]: { loading: false, result: null, reason: null, errorMsg },
        }));
      }
    } catch {
      setGpgProvisionState((s) => ({
        ...s,
        [appName]: { loading: false, result: null, reason: null, errorMsg: 'Netzwerkfehler bei der GPG-Provisionierung' },
      }));
    }
  }

  // ── F-073/S-339 AC8: Stufe 1 — Kandidat + Beweis-Runde ───────────────────
  // Ruft POST .../gpg-rotate/start auf. Startet KEINE neue Runde, während eine
  // vorherige noch läuft (Doppel-Klick-Schutz, analog handleGpgProvision).
  async function handleGpgRotateStart(appName) {
    if (!appName || gpgRotationState[appName]?.starting) return;
    setGpgRotationState((s) => ({
      ...s,
      [appName]: { ...s[appName], starting: true, startResult: null, commitResult: null },
    }));
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(appName)}/gpg-rotate/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      const startResult =
        res.ok && typeof data?.ok === 'boolean'
          ? data
          : { ok: false, errorClass: 'error', reason: typeof data?.reason === 'string' ? data.reason : 'Stufe 1 fehlgeschlagen' };
      setGpgRotationState((s) => ({
        ...s,
        [appName]: { ...s[appName], starting: false, startResult },
      }));
    } catch {
      setGpgRotationState((s) => ({
        ...s,
        [appName]: { ...s[appName], starting: false, startResult: { ok: false, errorClass: 'error', reason: 'Netzwerkfehler bei Stufe 1' } },
      }));
    }
  }

  // ── F-073/S-339 AC8: Stufe 2 — Umschalten (Commit-Punkt) ─────────────────
  // Ruft POST .../gpg-rotate/commit auf. Nur sinnvoll aufrufbar, wenn Stufe 1
  // dieser Session grün war (UI blockt vorher — Backend prüft ohnehin serverseitig).
  async function handleGpgRotateCommit(appName) {
    if (!appName || gpgRotationState[appName]?.committing) return;
    setGpgRotationState((s) => ({
      ...s,
      [appName]: { ...s[appName], committing: true, commitResult: null },
    }));
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(appName)}/gpg-rotate/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      const commitResult =
        res.ok && typeof data?.ok === 'boolean'
          ? data
          : { ok: false, errorClass: 'error', reason: typeof data?.reason === 'string' ? data.reason : 'Stufe 2 fehlgeschlagen' };
      setGpgRotationState((s) => ({
        ...s,
        [appName]: {
          ...s[appName],
          committing: false,
          commitResult,
          rotationCompleted: commitResult.ok === true ? true : s[appName]?.rotationCompleted ?? false,
        },
      }));
    } catch {
      setGpgRotationState((s) => ({
        ...s,
        [appName]: { ...s[appName], committing: false, commitResult: { ok: false, errorClass: 'error', reason: 'Netzwerkfehler bei Stufe 2' } },
      }));
    }
  }

  // ── F-073/S-339 AC9: Rollback-Anker-Aufräumen (getrennte, explizit bestätigte
  // Aktion) — Ruft POST .../gpg-rotate/discard-previous auf. Nur erreichbar, wenn
  // Stufe 2 dieser Session erfolgreich war, der Nutzer den Deploy-Erfolg selbst
  // bestätigt hat UND den App-Namen exakt eingetippt hat (type-to-confirm).
  async function handleGpgRotateDiscard(appName) {
    const rs = gpgRotationState[appName] ?? {};
    if (
      !appName ||
      rs.discarding ||
      rs.rotationCompleted !== true ||
      rs.deployConfirmed !== true ||
      rs.discardConfirmText !== appName
    ) {
      return;
    }
    setGpgRotationState((s) => ({
      ...s,
      [appName]: { ...s[appName], discarding: true, discardResult: null },
    }));
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(appName)}/gpg-rotate/discard-previous`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      const discardResult =
        res.ok && typeof data?.ok === 'boolean'
          ? data
          : { ok: false, errorClass: 'error', reason: typeof data?.reason === 'string' ? data.reason : 'Entsorgen fehlgeschlagen' };
      setGpgRotationState((s) => ({
        ...s,
        [appName]: discardResult.ok === true
          ? { ...s[appName], discarding: false, discardResult, rotationCompleted: false, deployConfirmed: false, discardConfirmText: '' }
          : { ...s[appName], discarding: false, discardResult },
      }));
    } catch {
      setGpgRotationState((s) => ({
        ...s,
        [appName]: { ...s[appName], discarding: false, discardResult: { ok: false, errorClass: 'error', reason: 'Netzwerkfehler beim Entsorgen' } },
      }));
    }
  }

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
          // S-186 AC8: tunnelId derived from VPS↔Tunnel-Read-Model, not from zone-tunnel dropdown
          tunnelId: vpsLinkedTunnelId,
          // zoneId resolved server-side
          // F-073/S-340 AC16: gpgBwItem-Default (env.gpg-passphrase-<slug>), überschreibbar
          ...(gpgBwItem.trim() ? { gpgBwItem: gpgBwItem.trim() } : {}),
          // deploy-config-volume-mount AC9 (F-078/S-348): nur senden, wenn die Checkbox
          // aktiv ist — sonst unveränderter Request (AC9).
          ...(requiresConfig
            ? {
                requiresConfig: true,
                ...(configApp.trim() ? { configApp: configApp.trim() } : {}),
                ...(configSeed.trim() ? { configSeed } : {}),
              }
            : {}),
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
        setSubdomain('');
        setGpgBwItem('');
        setGpgBwItemTouched(false);
        setRequiresConfig(false);
        setConfigApp('');
        setConfigAppTouched(false);
        setConfigSeed('');
        // Refresh list
        loadDeployments();
      } else {
        // AC12 (vps-readiness-gate): map errorClass first, then fall back to reason/error
        const errorClass = data?.errorClass;
        const reason = errorClass ?? data?.reason ?? data?.error ?? 'Deploy fehlgeschlagen';
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

        {/* ── F-073/S-337 AC7/AC8: Nach-Provisionierung GPG-Passphrase je App ── */}
        {packages.length > 0 && (
          <section style={styles.section} aria-label="GPG-Passphrasen provisionieren">
            <h2 style={styles.sectionTitle}>GPG-Passphrasen (Bitwarden)</h2>
            <p style={styles.hint}>
              Legt je App eine eigene, zufällige GPG-Passphrase in Bitwarden an (Item „env.gpg-passphrase-&lt;app&gt;"). Eine bereits vorhandene Passphrase wird nie überschrieben.
            </p>
            <ul style={styles.gpgProvisionList}>
              {packages.map((p) => {
                const st = gpgProvisionState[p.name] ?? {};
                const statusText = st.loading
                  ? null
                  : st.errorMsg
                    ? st.errorMsg
                    : st.result
                      ? friendlyGpgProvisionResult(st.result, st.reason)
                      : null;
                return (
                  <li key={p.name} style={styles.gpgProvisionRow}>
                    <span style={styles.gpgProvisionAppName}>{p.name}</span>
                    <button
                      type="button"
                      style={styles.btnSecondary}
                      disabled={st.loading}
                      aria-busy={st.loading}
                      aria-label={`GPG-Passphrase für ${p.name} in Bitwarden anlegen`}
                      onClick={() => handleGpgProvision(p.name)}
                    >
                      {st.loading ? 'Lege an…' : 'GPG-Passphrase in Bitwarden anlegen'}
                    </button>
                    {statusText && (
                      <span
                        role="alert"
                        aria-live="polite"
                        style={
                          !st.errorMsg && ['created', 'already-exists'].includes(st.result ?? '')
                            ? styles.successText
                            : styles.errorText
                        }
                      >
                        {statusText}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ── F-073/S-339 AC8/AC9: Per-App-GPG-Passphrase-Rotation ─────────── */}
        {packages.length > 0 && (
          <section style={styles.section} aria-label="GPG-Passphrasen-Rotation">
            <h2 style={styles.sectionTitle}>GPG-Passphrasen-Rotation</h2>
            <p style={styles.hint}>
              Rotiert die aktive GPG-Passphrase einer App zweistufig: Stufe 1 erzeugt einen
              Kandidaten und beweist ihn (Alt-Decrypt → Neu-Encrypt → Probe-Decrypt →
              Vergleich), ohne den aktiven Zustand zu ändern. Erst Stufe 2 schaltet um. Die
              alte Passphrase bleibt als Rollback-Anker erhalten, bis sie manuell entsorgt wird.
            </p>
            <ul style={styles.gpgRotationList}>
              {packages.map((p) => {
                const rs = gpgRotationState[p.name] ?? {};
                const stage1Ok = rs.startResult?.ok === true && rs.startResult?.phase === 'candidate-proved';
                const stage2Ok = rs.commitResult?.ok === true;
                const rotationCompleted = rs.rotationCompleted === true;
                const discardReady =
                  rotationCompleted && rs.deployConfirmed === true && rs.discardConfirmText === p.name;
                return (
                  <li key={p.name} style={styles.gpgRotationCard}>
                    <span style={styles.gpgProvisionAppName}>{p.name}</span>

                    {/* Stufe 1 + Stufe 2 (zweistufige Quittung, Muster Backup-Settings) */}
                    <div style={styles.btnRow}>
                      <button
                        type="button"
                        style={styles.btnSecondary}
                        disabled={rs.starting}
                        aria-busy={rs.starting}
                        aria-label={`Rotation für ${p.name}: Stufe 1 starten (Kandidat + Beweis-Runde)`}
                        onClick={() => handleGpgRotateStart(p.name)}
                      >
                        {rs.starting ? 'Stufe 1 läuft…' : 'Stufe 1: Kandidat + Beweis-Runde'}
                      </button>
                      <button
                        type="button"
                        style={styles.btnPrimary}
                        disabled={!stage1Ok || rs.committing}
                        aria-busy={rs.committing}
                        aria-label={`Rotation für ${p.name}: Stufe 2 umschalten`}
                        onClick={() => handleGpgRotateCommit(p.name)}
                      >
                        {rs.committing ? 'Stufe 2 läuft…' : 'Stufe 2: Umschalten'}
                      </button>
                    </div>

                    {rs.startResult && (
                      <div role="alert" aria-live="polite" style={stage1Ok ? styles.successBox : styles.warnBox}>
                        <p style={stage1Ok ? styles.successText : styles.warnText}>
                          {stage1Ok
                            ? 'Stufe 1: Kandidat erzeugt, Beweis-Runde erfolgreich — aktiver Zustand unverändert.'
                            : `Stufe 1 fehlgeschlagen: ${friendlyGpgRotateError(rs.startResult.errorClass, rs.startResult.reason)}`}
                        </p>
                      </div>
                    )}

                    {rs.commitResult && (
                      <div role="alert" aria-live="polite" style={stage2Ok ? styles.successBox : styles.warnBox}>
                        <p style={stage2Ok ? styles.successText : styles.warnText}>
                          {stage2Ok
                            ? 'Stufe 2: umgeschaltet — neue Passphrase ist aktiv, alte als Rollback-Anker gesichert.'
                            : `Stufe 2 fehlgeschlagen: ${friendlyGpgRotateError(rs.commitResult.errorClass, rs.commitResult.reason)}`}
                        </p>
                      </div>
                    )}

                    {/* AC9: Rollback-Anker-Aufräumen — getrennte, explizit bestätigte Aktion */}
                    <div style={styles.gpgDiscardBlock}>
                      <h3 style={styles.gpgDiscardHeading}>Rollback-Anker (alte Passphrase) aufräumen</h3>
                      {!rotationCompleted ? (
                        <p style={styles.warnText}>
                          Erst verfügbar, nachdem Stufe 2 (Umschalten) für {p.name} erfolgreich war.
                        </p>
                      ) : (
                        <>
                          <label style={styles.gpgDiscardConfirmLabel} htmlFor={`gpg-discard-deploy-confirmed-${p.name}`}>
                            <input
                              id={`gpg-discard-deploy-confirmed-${p.name}`}
                              type="checkbox"
                              checked={rs.deployConfirmed === true}
                              onChange={(e) =>
                                setGpgRotationState((s) => ({
                                  ...s,
                                  [p.name]: { ...s[p.name], deployConfirmed: e.target.checked },
                                }))
                              }
                              style={styles.gpgDiscardCheckbox}
                            />
                            {' '}Ich bestätige: ein Deploy mit der neuen Passphrase ist erfolgreich durchgelaufen.
                          </label>
                          {rs.deployConfirmed !== true && (
                            <p style={styles.warnText}>
                              Ohne diese Bestätigung bleibt der Aufräum-Knopf gesperrt.
                            </p>
                          )}
                          <div style={styles.row}>
                            <label style={styles.label} htmlFor={`gpg-discard-confirm-${p.name}`}>
                              App-Name zum Bestätigen eintippen (type-to-confirm)
                            </label>
                            <input
                              id={`gpg-discard-confirm-${p.name}`}
                              type="text"
                              style={styles.input}
                              value={rs.discardConfirmText ?? ''}
                              disabled={rs.deployConfirmed !== true}
                              onChange={(e) =>
                                setGpgRotationState((s) => ({
                                  ...s,
                                  [p.name]: { ...s[p.name], discardConfirmText: e.target.value },
                                }))
                              }
                              placeholder={p.name}
                              autoComplete="off"
                              aria-describedby={`gpg-discard-confirm-hint-${p.name}`}
                            />
                            <span id={`gpg-discard-confirm-hint-${p.name}`} style={styles.inputHint}>
                              Tippe exakt: {p.name}
                            </span>
                          </div>
                          <button
                            type="button"
                            style={styles.btnDanger}
                            disabled={!discardReady || rs.discarding}
                            aria-busy={rs.discarding}
                            aria-label={`Rollback-Anker für ${p.name} entsorgen`}
                            onClick={() => handleGpgRotateDiscard(p.name)}
                          >
                            {rs.discarding ? 'Entsorge…' : 'Rollback-Anker entsorgen'}
                          </button>
                        </>
                      )}
                      {rs.discardResult && (
                        <div role="alert" aria-live="polite" style={rs.discardResult.ok ? styles.successBox : styles.errorBox}>
                          <p style={rs.discardResult.ok ? styles.successText : styles.errorText}>
                            {rs.discardResult.ok
                              ? 'Rollback-Anker entsorgt.'
                              : `Entsorgen fehlgeschlagen: ${friendlyGpgRotateError(rs.discardResult.errorClass, rs.discardResult.reason)}`}
                          </p>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

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

            {/* AC10: VPS-Dropdown + Readiness-Badge (AC9) */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-vps-select">VPS</label>
              <div style={styles.vpsRow}>
                <select
                  id="deploy-vps-select"
                  style={{ ...styles.input, flex: 1, width: 'auto' }}
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
                {/* AC9: Readiness-Badge — only when a VPS is selected */}
                {selectedVps && (
                  <VpsReadinessBadge state={vpsReadiness} />
                )}
                {/* S-186 AC9: Tunnel-Badge — only when a VPS is selected */}
                {selectedVps && tunnelPresent !== null && (
                  <TunnelStatusBadge present={tunnelPresent} />
                )}
                {/* S-188 AC9: Tunnel-Selbstheilung-Knopf — nur wenn Tunnel fehlt */}
                {selectedVps && tunnelPresent !== null && tunnelPresent !== true && (
                  <button
                    type="button"
                    style={
                      tunnelHealState === 'running'
                        ? { ...styles.btnTunnelHeal, opacity: 0.6, cursor: 'not-allowed' }
                        : styles.btnTunnelHeal
                    }
                    disabled={tunnelHealState === 'running'}
                    aria-busy={tunnelHealState === 'running'}
                    aria-label="Tunnel neu anlegen und bestücken"
                    onClick={handleTunnelHeal}
                  >
                    {tunnelHealState === 'running' ? 'Tunnel wird wiederhergestellt…' : 'Tunnel neu anlegen & bestücken'}
                  </button>
                )}
              </div>
            </div>

            {/* S-188 AC10: Tunnel-Selbstheilung Ergebnis-Anzeige */}
            {selectedVps && tunnelHealResult && (
              <TunnelHealResultDisplay result={tunnelHealResult} />
            )}

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

            {/* S-186 AC8: Tunnel is derived from VPS selection (VPS↔Tunnel-Kopplung).
                The zone-tunnel dropdown below is kept for information only (zone selection UX);
                it is NOT the source of the tunnelId sent in the deploy POST.
                The effective tunnelId (vpsLinkedTunnelId) comes from the VPS↔Tunnel-Read-Model. */}
            {selectedVps && (
              <div style={styles.row}>
                <label style={styles.label}>Tunnel (aus VPS-Kopplung)</label>
                <span style={{ ...styles.input, display: 'flex', alignItems: 'center', color: vpsLinkedTunnelId ? '#e5e7eb' : '#9ca3af', fontStyle: vpsLinkedTunnelId ? 'normal' : 'italic' }}>
                  {vpsLinkedTunnelId ?? '— kein Tunnel diesem VPS zugeordnet —'}
                </span>
                <span style={styles.inputHint}>
                  Tunnel wird automatisch aus der VPS-Registrierung übernommen.
                </span>
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

            {/* F-073/S-340 AC16: GPG-Bitwarden-Item — Default env.gpg-passphrase-<slug>
                abgeleitet, überschreibbar; ein manuell gesetzter Wert folgt dem Slug-Wechsel
                nicht mehr. */}
            <div style={styles.row}>
              <label style={styles.label} htmlFor="deploy-gpg-bw-item">GPG-Bitwarden-Item</label>
              <input
                id="deploy-gpg-bw-item"
                type="text"
                style={styles.input}
                value={gpgBwItem}
                onChange={(e) => {
                  setGpgBwItem(e.target.value);
                  setGpgBwItemTouched(true);
                }}
                placeholder="env.gpg-passphrase-<app>"
                aria-label="Bitwarden-Item für die GPG-Passphrase (editierbar)"
                aria-describedby="deploy-gpg-bw-item-hint"
              />
              <span id="deploy-gpg-bw-item-hint" style={styles.inputHint}>
                Automatisch aus dem gewählten Image abgeleitet; bei Bedarf überschreibbar.
              </span>
            </div>

            {/* deploy-config-volume-mount AC9 (F-078/S-348): config.yaml-Mount-Checkbox
                + optionales Seed-Feld + read-only Host-Pfad-Vorschau. */}
            <div style={styles.row}>
              <label style={styles.gpgDiscardConfirmLabel} htmlFor="deploy-requires-config">
                <input
                  id="deploy-requires-config"
                  type="checkbox"
                  checked={requiresConfig}
                  onChange={(e) => setRequiresConfig(e.target.checked)}
                  style={styles.gpgDiscardCheckbox}
                />
                {' '}config.yaml auf dem VPS bereitstellen (read-only nach /app/config.yaml gemountet)
              </label>
            </div>

            {requiresConfig && (
              <>
                <div style={styles.row}>
                  <label style={styles.label} htmlFor="deploy-config-app">config-App-Slug</label>
                  <input
                    id="deploy-config-app"
                    type="text"
                    style={styles.input}
                    value={configApp}
                    onChange={(e) => {
                      setConfigApp(e.target.value);
                      setConfigAppTouched(true);
                    }}
                    placeholder="app-name"
                    aria-label="config-App-Slug (editierbar)"
                    aria-describedby="deploy-config-host-path-preview"
                  />
                  <span id="deploy-config-host-path-preview" style={styles.inputHint}>
                    {configApp.trim()
                      ? `Host-Pfad: ~/apps/${configApp.trim()}/config.yaml`
                      : 'Host-Pfad: (config-App-Slug wählen)'}
                  </span>
                </div>

                <div style={styles.row}>
                  <label style={styles.label} htmlFor="deploy-config-seed">config.yaml-Seed (optional, Erst-Deploy)</label>
                  <textarea
                    id="deploy-config-seed"
                    style={{ ...styles.input, minHeight: 120, fontFamily: 'monospace', resize: 'vertical' }}
                    value={configSeed}
                    onChange={(e) => setConfigSeed(e.target.value)}
                    placeholder="# Erst-Inhalt der config.yaml — wird nur geschrieben, wenn die Host-Datei noch nicht existiert"
                    aria-label="config.yaml-Seed-Inhalt (optional)"
                    aria-describedby="deploy-config-seed-hint"
                  />
                  <span id="deploy-config-seed-hint" style={styles.inputHint}>
                    Nur für die einmalige Erst-Provisionierung — eine bereits bestehende Host-config.yaml wird nie überschrieben.
                  </span>
                </div>
              </>
            )}

            {/* ── S-156: Lokal testen (vor Deploy auf VPS) ──────────────── */}
            {(selectedPackage && selectedTag) && (
              <div style={styles.localTestSection}>
                <button
                  type="button"
                  style={localTesting
                    ? { ...styles.btnLocalTest, opacity: 0.6, cursor: 'not-allowed' }
                    : styles.btnLocalTest}
                  disabled={localTesting}
                  aria-busy={localTesting}
                  onClick={handleLocalTest}
                >
                  {localTesting ? 'Teste lokal…' : 'Lokal testen'}
                </button>
                {localTestResult && (
                  <div
                    role="status"
                    aria-live="polite"
                    style={localTestResult.ok ? styles.localTestOk : styles.localTestError}
                  >
                    {localTestResult.ok ? (
                      <LocalTestReport report={localTestResult.report} />
                    ) : (
                      <p style={{ margin: 0, fontSize: 13 }}>
                        Lokal-Test fehlgeschlagen: {localTestResult.reason}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

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

// ── VpsReadinessBadge component (S-181, AC9) ─────────────────────────────────

/**
 * Shows a status badge reflecting the VPS readiness state.
 * Rendered only when a VPS is selected.
 *
 * @param {{ state: 'unknown'|'unreachable'|'provisioning'|'ready' }} props
 */
function VpsReadinessBadge({ state }) {
  let text;
  let badgeStyle;

  switch (state) {
    case 'unreachable':
      text = '⏳ VPS wird hochgefahren…';
      badgeStyle = styles.badgeWaiting;
      break;
    case 'provisioning':
      text = '⏳ VPS wird eingerichtet (Docker installieren)…';
      badgeStyle = styles.badgeWaiting;
      break;
    case 'ready':
      text = '✅ VPS bereit';
      badgeStyle = styles.badgeReady;
      break;
    default:
      // 'unknown' = first poll pending
      text = '⏳ Bereitschaft wird geprüft…';
      badgeStyle = styles.badgeWaiting;
  }

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`VPS-Bereitschaft: ${text}`}
      style={badgeStyle}
    >
      {text}
    </span>
  );
}

// ── TunnelStatusBadge component (S-186, AC9) ─────────────────────────────────

/**
 * Shows a status badge reflecting tunnel existence for the selected VPS.
 * Rendered only when a VPS is selected (tunnelPresent !== null from parent).
 *
 * @param {{ present: boolean|'unknown'|null }} props
 */
function TunnelStatusBadge({ present }) {
  // null = no VPS / initial (should not render — parent guards)
  // true  → "Tunnel ✓"
  // false → "Tunnel fehlt ✗"
  // 'unknown' → "Tunnel fehlt ✗" (Cloudflare nicht erreichbar — fail-visible per spec)
  if (present === null) return null;

  const ok = present === true;
  const text = ok ? 'Tunnel ✓' : 'Tunnel fehlt ✗';
  const badgeStyle = ok ? styles.badgeTunnelOk : styles.badgeTunnelMissing;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Tunnel-Status: ${text}`}
      style={badgeStyle}
    >
      {text}
    </span>
  );
}

// ── TunnelHealResultDisplay component (S-188, AC9/AC10) ──────────────────────

/**
 * Renders the result of a tunnel heal operation in a friendly, secret-free way (AC10).
 * Shows Phase-1/2/3 status + per-hostname route results.
 * Never displays tokens, SSH keys, or raw error messages (AC11).
 *
 * @param {{ result: { ok: boolean, partial?: boolean, report?: object, errorMsg?: string } }} props
 */
function TunnelHealResultDisplay({ result }) {
  if (!result) return null;

  const { ok, partial, report, errorMsg } = result;

  // Error path (Phase 1 failed or network error)
  if (!ok && !partial && !report) {
    return (
      <div role="alert" aria-live="polite" style={styles.errorBox}>
        <p style={styles.errorText}>
          Tunnel-Wiederherstellung fehlgeschlagen: {errorMsg ?? 'Unbekannter Fehler'}
        </p>
      </div>
    );
  }

  const boxStyle = ok ? styles.successBox : styles.warnBox;
  const textStyle = ok ? styles.successText : styles.warnText;

  return (
    <div role="status" aria-live="polite" style={boxStyle}>
      <p style={{ ...textStyle, marginBottom: 6 }}>
        {ok
          ? 'Tunnel erfolgreich wiederhergestellt.'
          : 'Tunnel teilweise wiederhergestellt (Teil-Fehler).'}
      </p>

      {/* Phase 1 */}
      {report?.phase1 && (
        <p style={{ ...textStyle, fontSize: 12 }}>
          Phase 1 (Tunnel anlegen): {report.phase1.ok ? 'OK' : `Fehler — ${friendlyPhase1Error(report.phase1.errorClass)}`}
        </p>
      )}

      {/* Phase 2 */}
      {report?.phase2 && (
        <p style={{ ...textStyle, fontSize: 12 }}>
          Phase 2 (Token-Push + cloudflared-Neustart):{' '}
          {report.phase2.ok
            ? 'OK'
            : `Fehlgeschlagen — ${friendlyPhase2Error(report.phase2.errorClass)}`}
        </p>
      )}

      {/* Phase 3: per-Container Routen-Ergebnisse */}
      {Array.isArray(report?.routes) && report.routes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p style={{ ...textStyle, fontSize: 12, marginBottom: 4 }}>
            Phase 3 (Routen bestücken):
          </p>
          {report.routes.map((r, i) => (
            <p key={i} style={{ ...textStyle, fontSize: 12, marginLeft: 12 }}>
              {r.hostname}: {friendlyRouteResult(r.result)}
            </p>
          ))}
        </div>
      )}

      {/* Partial-Hinweis wenn kein Phase-2-Fehler aber Phase-3-Fehler */}
      {partial && report?.phase2?.ok && (
        <p style={{ ...textStyle, fontSize: 12, marginTop: 6 }}>
          Einzelne Routen konnten nicht angelegt werden. VPS erneut verbinden oder Reconciliation abwarten.
        </p>
      )}

      {/* Phase-2-Fehler-Hinweis */}
      {report?.phase2 && !report.phase2.ok && (
        <p style={{ ...textStyle, fontSize: 12, marginTop: 6 }}>
          VPS konnte nicht erreicht werden. Routen wurden nicht bestückt.
          Tunnel ist im System referenziert — bei erneuter VPS-Verbindung nochmals versuchen.
        </p>
      )}
    </div>
  );
}

/** Friendly message for a route result (AC10: no raw error text). */
function friendlyRouteResult(result) {
  switch (result) {
    case 'route-created':      return 'Angelegt';
    case 'protected-skipped':  return 'Uebersprungen (geschuetzt)';
    case 'error':              return 'Fehlgeschlagen';
    default:                   return 'Unbekannt';
  }
}

/** Friendly message for Phase-1 error (AC10: no raw Cloudflare error). */
function friendlyPhase1Error(errorClass) {
  switch (errorClass) {
    case 'cloudflare-not-configured': return 'Cloudflare nicht konfiguriert';
    case 'cloudflare-auth-failed':    return 'Cloudflare-Authentifizierung fehlgeschlagen';
    case 'cloudflare-unavailable':    return 'Cloudflare nicht erreichbar';
    default:                          return 'Tunnel konnte nicht angelegt werden';
  }
}

/** Friendly message for Phase-2 error (AC10: no raw SSH/cloudflare error). */
function friendlyPhase2Error(errorClass) {
  switch (errorClass) {
    case 'unreachable':        return 'VPS nicht erreichbar';
    case 'auth-failed':        return 'SSH-Authentifizierung fehlgeschlagen';
    case 'no-private-key':     return 'Kein SSH-Key hinterlegt';
    case 'docker-failed':      return 'cloudflared-Neustart fehlgeschlagen';
    case 'vps-target-missing': return 'VPS-Ziel nicht konfiguriert';
    default:                   return 'VPS nicht erreichbar';
  }
}

/**
 * Maps a backend error response to a user-friendly message (AC10).
 * Never exposes tokens, keys, or raw error text.
 *
 * @param {object} data - raw response body from tunnel/recreate
 * @returns {string}
 */
function formatTunnelHealError(data) {
  const errorClass = data?.errorClass ?? data?.error ?? '';
  switch (errorClass) {
    case 'cloudflare-not-configured':
      return 'Cloudflare ist nicht konfiguriert. Bitte Cloudflare-Token in den Einstellungen hinterlegen.';
    case 'cloudflare-auth-failed':
      return 'Cloudflare-Authentifizierung fehlgeschlagen. Bitte API-Token pruefen.';
    case 'cloudflare-unavailable':
      return 'Cloudflare ist nicht erreichbar. Bitte spaeter erneut versuchen.';
    default:
      return 'Tunnel-Wiederherstellung fehlgeschlagen. Bitte spaeter erneut versuchen.';
  }
}

// ── F-073/S-337 AC7/AC8: geheimnisfreie Quittung der GPG-Provisionierung ────

/**
 * Formatiert das Ergebnis der Nach-Provisionierung (F-073/S-337 AC7/AC8) als
 * geheimnisfreien Klartext-Hinweis. Zeigt NIE die Passphrase — sie ist schon
 * per Vertrag nicht Teil der Response (nur `result`/`reason`).
 * @param {'created'|'already-exists'|'access-not-ready'|'failed'} result
 * @param {string|null} reason
 * @returns {string}
 */
function friendlyGpgProvisionResult(result, reason) {
  switch (result) {
    case 'created':
      return 'Angelegt — GPG-Passphrase wurde in Bitwarden hinterlegt.';
    case 'already-exists':
      return reason ?? 'Bereits vorhanden — keine Änderung.';
    case 'access-not-ready':
      return reason ?? 'Bitwarden-Deploy-Zugang ist noch nicht eingerichtet.';
    case 'failed':
      return reason ?? 'GPG-Provisionierung fehlgeschlagen.';
    default:
      return reason ?? 'Unbekanntes Ergebnis.';
  }
}

// ── F-073/S-339 AC8/AC9: geheimnisfreie Quittung der GPG-Passphrasen-Rotation ──

/**
 * Formatiert eine Rotations-`errorClass` (per-app-gpg-passphrase-rotation.md
 * Fehlerklassen-Liste) als geheimnisfreien Klartext-Hinweis. Zeigt NIE die
 * Passphrase oder `.env.gpg`-Klartext — sie sind schon per Vertrag nicht Teil
 * der Response (nur `ok`/`phase`/`errorClass`/`reason`).
 * @param {string|undefined} errorClass
 * @param {string|null|undefined} reason
 * @returns {string}
 */
function friendlyGpgRotateError(errorClass, reason) {
  switch (errorClass) {
    case 'clone-missing':
      return reason ?? 'Workspace-Klon fehlt — App zuerst in den Workspace klonen.';
    case 'access-not-ready':
      return reason ?? 'Bitwarden-Deploy-Zugang ist noch nicht eingerichtet.';
    case 'decrypt-old-failed':
      return reason ?? 'Die aktuelle .env.gpg ließ sich mit der aktiven Passphrase nicht entschlüsseln.';
    case 'encrypt-new-failed':
      return reason ?? 'Verschlüsseln mit der neuen Passphrase fehlgeschlagen.';
    case 'verify-failed':
      return reason ?? 'Beweis-Runde: Vergleich der entschlüsselten Inhalte fehlgeschlagen.';
    case 'bw-update-failed':
      return reason ?? 'Bitwarden-Item ließ sich nicht aktualisieren.';
    case 'push-failed':
      return reason ?? 'Push auf den Default-Branch fehlgeschlagen — Bitwarden wurde zurückgerollt.';
    case 'commit-failed':
      return reason ?? 'Commit der .env.gpg im Klon fehlgeschlagen.';
    case 'branch-mismatch':
      return reason ?? 'Der Workspace-Klon steht nicht auf dem Default-Branch der App — Abbruch.';
    default:
      return reason ?? 'Rotation fehlgeschlagen.';
  }
}

// ── LocalTestReport component (S-156) ────────────────────────────────────────

/**
 * Renders a structured LocalTestReport (AC2, AC3).
 * @param {{ report: import('../../src/deploy/LocalDockerControl.js').LocalTestReport }} props
 */
function LocalTestReport({ report }) {
  if (!report) return null;
  const rows = [
    ['Gestartet', report.started ? 'ja' : 'nein'],
    ['Frühzeitig beendet (crash)', report.exitedEarly ? 'ja' : 'nein'],
    ['Host-Port', report.hostPort != null ? String(report.hostPort) : 'keiner'],
    ['Exponierte Ports', report.exposedPorts?.length > 0 ? report.exposedPorts.join(', ') : '—'],
    ['Erreichbar (HTTP)', report.reachable ? 'ja' : 'nein'],
    ['Dauer', `${report.durationMs ?? '?'} ms`],
  ];
  if (report.reason) {
    rows.push(['Hinweis', report.reason]);
  }
  return (
    <div>
      <p style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600 }}>
        Lokal-Test abgeschlossen {report.started ? '(gestartet)' : '(nicht gestartet)'}
      </p>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 160 }}>{label}:</span>
          <span style={{ fontSize: 12, color: '#e5e7eb' }}>{value}</span>
        </div>
      ))}
    </div>
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
    // AC12 (vps-readiness-gate): friendly retry hint for provisioning errors
    case 'vps-provisioning':
    case 'docker-failed':
      return 'VPS wird noch eingerichtet (Docker installieren) – in ~1–2 Min erneut versuchen';
    // S-186 AC11: tunnel-missing / tunnel-mismatch → freundliche, handlungsleitende Meldungen
    case 'tunnel-missing':
      return 'Tunnel fuer diesen VPS fehlt in Cloudflare – bitte ueber „Tunnel neu anlegen & bestuecken" wiederherstellen';
    case 'tunnel-mismatch':
      return 'Tunnel-ID stimmt nicht mit dem fuer diesen VPS registrierten Tunnel ueberein (Fehlverdrahtungs-Schutz) – VPS im Formular neu waehlen';
    // deploy-config-volume-mount AC6/AC2 (F-078/S-348): freundliche Hinweise für das config-Gate
    case 'config-file-missing':
      return 'config.yaml fehlt auf dem VPS – bitte per SSH ablegen oder einen Seed-Inhalt mitgeben';
    case 'config-app-invalid':
      return 'Ungueltiger config-App-Slug (nur a-z 0-9 . _ - erlaubt, muss mit a-z0-9 beginnen)';
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
  // S-188 AC9: Tunnel-Selbstheilung-Knopf (orange/amber tone — destructive-adjacent but constructive)
  // Contrast: #fbbf24 on #7c2d12 ≈ 4.7:1 (WCAG AA)
  btnTunnelHeal: {
    padding: '6px 12px',
    background: '#7c2d12',
    color: '#fbbf24',
    border: '1px solid #92400e',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 36,
    minWidth: 200,
    whiteSpace: 'nowrap',
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
  // F-073/S-337 AC7/AC8: GPG-Provisionierung je App
  gpgProvisionList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  gpgProvisionRow: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid #1e293b',
  },
  gpgProvisionAppName: {
    flex: '0 0 180px',
    fontSize: 13,
    color: '#d4d4d4',
    wordBreak: 'break-all',
  },
  // F-073/S-339 AC8/AC9: GPG-Passphrasen-Rotation je App
  gpgRotationList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  gpgRotationCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '14px 16px',
    background: '#0f172a',
    border: '1px solid #1e293b',
    borderRadius: 6,
  },
  gpgDiscardBlock: {
    marginTop: 8,
    paddingTop: 12,
    borderTop: '1px solid #1e293b',
  },
  gpgDiscardHeading: {
    margin: '0 0 6px',
    fontSize: 13,
    fontWeight: 600,
    color: '#e5e7eb',
  },
  gpgDiscardConfirmLabel: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    color: '#e5e7eb',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1.4,
    minHeight: 44,
  },
  gpgDiscardCheckbox: {
    marginTop: 2,
    minWidth: 16,
    minHeight: 16,
    cursor: 'pointer',
  },
  // Local-Test (S-156)
  localTestSection: {
    marginTop: 12,
    marginBottom: 12,
    padding: '12px 16px',
    background: '#0f172a',
    border: '1px solid #1e3a5f',
    borderRadius: 6,
  },
  btnLocalTest: {
    padding: '8px 16px',
    background: '#0e4a7a',
    color: '#93c5fd',
    border: '1px solid #1e6fab',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    minWidth: 120,
  },
  localTestOk: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#071826',
    border: '1px solid #0e4a7a',
    borderRadius: 4,
    color: '#93c5fd',
  },
  localTestError: {
    marginTop: 10,
    padding: '10px 14px',
    background: '#1c0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
  },
  // VPS-Row: select + readiness badge side-by-side (AC9)
  vpsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  // Readiness badge: waiting states (unreachable / provisioning / unknown)
  badgeWaiting: {
    display: 'inline-block',
    fontSize: 12,
    color: '#fcd34d',
    background: '#1c1400',
    border: '1px solid #78350f',
    borderRadius: 4,
    padding: '4px 8px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  // Readiness badge: ready state
  badgeReady: {
    display: 'inline-block',
    fontSize: 12,
    color: '#86efac',
    background: '#0a1c0a',
    border: '1px solid #14532d',
    borderRadius: 4,
    padding: '4px 8px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  // Tunnel badge: present (S-186 AC9)
  badgeTunnelOk: {
    display: 'inline-block',
    fontSize: 12,
    color: '#86efac',
    background: '#0a1c0a',
    border: '1px solid #14532d',
    borderRadius: 4,
    padding: '4px 8px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  // Tunnel badge: missing or unknown (S-186 AC9)
  badgeTunnelMissing: {
    display: 'inline-block',
    fontSize: 12,
    color: '#fca5a5',
    background: '#1c0a0a',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    padding: '4px 8px',
    whiteSpace: 'nowrap',
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
