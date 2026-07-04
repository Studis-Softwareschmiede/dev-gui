/**
 * ZugaengeCategory.jsx — Kategorie-Wrapper für Zugänge & Schlüssel.
 *
 * Enthält (unverändert):
 *   - GitHub-Credential-Felder (app_id, installation_id, private_key)
 *   - Cloudflare-Credential-Felder (api_token, account_id)
 *   - VPS-Provider-Credential-Felder (hetzner, ionos, hostinger tokens)
 *   - SshKeysSection
 *
 * AC16: Bestehende id/aria-labelledby-Werte bleiben unverändert:
 *   - settings-section-github
 *   - settings-section-cloudflare
 *   - settings-section-vps
 *   - settings-section-ssh-keys
 *
 * Props:
 *   - credentials: array of credential objects
 *   - sshKeys: array of SSH key objects
 *   - sshLoadError: string or null
 *   - setSshKeys: (sshKeys) => void
 *   - onLoad: async () => void (callback when any cred is saved)
 *   - fetchFn: typeof fetch
 *   - getMeta: (integration: string, name: string) => object | undefined
 */

import { CredentialField } from '../CredentialField.jsx';
import { SshKeysSection } from '../SshKeysSection.jsx';
import { KNOWN_FIELDS } from '../settingsApi.js';

const styles = {
  section: {
    marginBottom: 32,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  sectionHeading: {
    margin: '0 0 8px',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
  },
  sectionDesc: {
    margin: '0 0 16px',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
  loadError: {
    padding: '12px 16px',
    marginBottom: 24,
    background: '#2d0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    color: '#fca5a5',
    fontSize: 14,
  },
};

export function ZugaengeCategory({
  sshKeys,
  sshLoadError,
  setSshKeys,
  onLoad,
  getMeta,
}) {
  return (
    <>
      {/* GitHub */}
      <section aria-labelledby="settings-section-github" style={styles.section}>
        <h2 id="settings-section-github" style={styles.sectionHeading}>GitHub</h2>
        <p style={styles.sectionDesc}>GitHub-App-Credentials, Token und Organisations-Zugang.</p>
        {KNOWN_FIELDS.github.map(({ name, label }) => (
          <CredentialField
            key={name}
            integration="github"
            name={name}
            label={label}
            meta={getMeta('github', name)}
            onSaved={onLoad}
          />
        ))}
      </section>

      {/* Cloudflare */}
      <section aria-labelledby="settings-section-cloudflare" style={styles.section}>
        <h2 id="settings-section-cloudflare" style={styles.sectionHeading}>Cloudflare</h2>
        <p style={styles.sectionDesc}>API-Token für Tunnel, Access und DNS-Verwaltung.</p>
        {KNOWN_FIELDS.cloudflare.map(({ name, label }) => (
          <CredentialField
            key={name}
            integration="cloudflare"
            name={name}
            label={label}
            meta={getMeta('cloudflare', name)}
            onSaved={onLoad}
          />
        ))}
      </section>

      {/* VPS-Provider */}
      <section aria-labelledby="settings-section-vps" style={styles.section}>
        <h2 id="settings-section-vps" style={styles.sectionHeading}>VPS-Provider</h2>
        <p style={styles.sectionDesc}>API-Token je Provider (Hetzner, IONOS, Hostinger) für Provisionierung und Verwaltung.</p>
        {KNOWN_FIELDS.vps.map(({ name, label }) => (
          <CredentialField
            key={name}
            integration="vps"
            name={name}
            label={label}
            meta={getMeta('vps', name)}
            onSaved={onLoad}
          />
        ))}
      </section>

      {/* SSH-Keys */}
      <section aria-labelledby="settings-section-ssh-keys" style={styles.section}>
        <h2 id="settings-section-ssh-keys" style={styles.sectionHeading}>SSH-Keys</h2>
        <p style={styles.sectionDesc}>
          Öffentliche und private SSH-Schlüssel je Benutzer-Label (z.B. root, alex).
          Public-Keys dürfen vollständig angezeigt werden. Private-Keys sind write-only.
        </p>
        {sshLoadError && (
          <p style={styles.loadError} role="alert" aria-live="polite">
            SSH-Keys konnten nicht geladen werden: {sshLoadError}
          </p>
        )}
        <SshKeysSection sshKeys={sshKeys} setSshKeys={setSshKeys} onSaved={onLoad} />
      </section>
    </>
  );
}
