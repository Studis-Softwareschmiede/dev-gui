/**
 * VpsView.jsx — VPS-Ansicht mit Machine-Listing und Create-from-scratch-Formular.
 *
 * Implements: vps-ssh-key-assignment AC1/AC2 (UI-Auswahl)
 *   AC1 — Create-Formular bietet je Rolle (root, alex) eine Auswahl der SSH-Labels
 *          mit gesetztem Public-Key; Labels ohne Public-Key werden nicht angeboten.
 *   AC2 — Default-Vorbelegung: gleichnamiges Label → Rolle (Label "root" → root,
 *          Label "alex" → alex); übersteuerbar. Distinkte Keys möglich.
 *   AC5 — UI sperrt Create-Button wenn kein Label mit Public-Key vorhanden ist
 *          oder eine Rolle kein Label zugeordnet hat.
 *
 * Security (Floor):
 *   - Nur Label-Referenzen werden an das Backend gesendet (sshKeyAssignment),
 *     niemals rohe Key-Material-Strings vom Client.
 *   - Public-Keys dürfen angezeigt werden (nicht geheim).
 *
 * A11y: WCAG 2.1 AA — Beschriftete select/input-Elemente, aria-required,
 *   aria-describedby für Fehlermeldungen, role=alert, Touch-Target ≥ 44 px.
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

// ── VpsCreateForm ─────────────────────────────────────────────────────────────

/**
 * Create-Formular — Pro Rolle (root, alex) ein Dropdown mit verfügbaren SSH-Labels.
 * Default-Vorbelegung: gleichnamiges Label → Rolle (AC2).
 * UI-Sperre wenn kein wählbares Label vorhanden (AC5).
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

  // Hinweis wenn beide Rollen dasselbe Label nutzen (non-distinkter Key)
  const nonDistinct = rootLabel && alexLabel && rootLabel === alexLabel;

  // AC5: Create gesperrt wenn kein Label mit Key vorhanden oder eine Rolle leer
  const noLabelsAvailable = labelsWithKey.length === 0;
  const missingAssignment = !rootLabel || !alexLabel;
  const createBlocked = noLabelsAvailable || missingAssignment || !provider || !name.trim() || !region.trim() || !serverType.trim();

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

      {/* Region */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-region" style={createStyles.label}>
          Region <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
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
      </div>

      {/* Server-Typ */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-servertype" style={createStyles.label}>
          Server-Typ <span aria-hidden="true" style={createStyles.required}>*</span>
        </label>
        <input
          id="vps-create-servertype"
          type="text"
          value={serverType}
          onChange={(e) => setServerType(e.target.value)}
          placeholder="z.B. cx11 oder cx21"
          style={createStyles.input}
          aria-required="true"
          aria-describedby={error ? ERROR_ID : undefined}
          autoComplete="off"
          disabled={submitting}
        />
      </div>

      {/* Image (optional) */}
      <div style={createStyles.field}>
        <label htmlFor="vps-create-image" style={createStyles.label}>
          Image <span style={createStyles.optional}>(optional)</span>
        </label>
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

// ── VpsMachineList ────────────────────────────────────────────────────────────

/**
 * Listet alle bekannten VPS-Maschinen auf.
 *
 * @param {{ machines: Array, providerErrors?: Array }} props
 */
function VpsMachineList({ machines, providerErrors }) {
  if (machines.length === 0 && (!providerErrors || providerErrors.length === 0)) {
    return <p style={listStyles.empty}>Keine Maschinen vorhanden.</p>;
  }

  return (
    <div>
      {providerErrors && providerErrors.length > 0 && (
        <div style={listStyles.providerErrors} role="status">
          {providerErrors.map((e) => (
            <span key={e.provider} style={listStyles.providerError}>
              {e.provider}: {e.errorClass}
            </span>
          ))}
        </div>
      )}
      <ul style={listStyles.list} aria-label="VPS-Maschinen">
        {machines.map((m) => (
          <li key={`${m.provider}:${m.serverId}`} style={listStyles.item}>
            <span style={listStyles.name}>{m.name}</span>
            <span style={listStyles.provider}>{m.provider}</span>
            <span style={listStyles.status(m.status)}>{m.status}</span>
            {m.ipv4 && <span style={listStyles.ip}>{m.ipv4}</span>}
          </li>
        ))}
      </ul>
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

  return (
    <main style={styles.view} aria-label="VPS-Ansicht">
      <div style={styles.inner}>
        <h1 style={styles.title}>VPS</h1>

        {loadError && (
          <p style={styles.loadError} role="alert" aria-live="polite">
            {loadError}
          </p>
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

            <VpsMachineList machines={machines} providerErrors={providerErrors} />
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
    minHeight: 36,
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
};
