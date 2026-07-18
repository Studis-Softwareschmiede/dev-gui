/**
 * ZugaengeCategory.jsx — Kategorie-Wrapper für Zugänge & Schlüssel.
 *
 * Enthält (unverändert):
 *   - GitHub-Credential-Felder (app_id, installation_id, private_key)
 *   - Cloudflare-Credential-Felder (api_token, account_id)
 *   - VPS-Provider-Credential-Felder (hetzner, ionos, hostinger tokens)
 *   - SshKeysSection
 *
 * Neu (anthropic-oauth-vault AC10/AC11, S-368):
 *   - Claude-Abo-Credential-Felder (access_token, refresh_token) + Ablauf-Anzeige
 *
 * AC16: Bestehende id/aria-labelledby-Werte bleiben unverändert:
 *   - settings-section-github
 *   - settings-section-cloudflare
 *   - settings-section-vps
 *   - settings-section-ssh-keys
 * Neu: settings-section-anthropic-oauth (S-368)
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

/**
 * Formatiert den Ablaufzeitpunkt (Unix-ms) des Abo-OAuth-Access-Tokens de-CH
 * lokalisiert (anthropic-oauth-vault AC10). Fehlt/unparsebar → "kein Ablaufdatum".
 *
 * @param {number|undefined} expiresAtMs
 * @returns {string}
 */
export function formatAnthropicOAuthExpiresAt(expiresAtMs) {
  if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
    return 'kein Ablaufdatum';
  }
  const d = new Date(expiresAtMs);
  if (Number.isNaN(d.getTime())) return 'kein Ablaufdatum';
  return d.toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
}

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
  // anthropic-oauth-vault AC10 (S-368): Ablauf-Anzeige des Access-Tokens
  expiresAtHint: {
    margin: '8px 0 0',
    fontSize: 12,
    color: '#9ca3af',   // Kontrast ≥ 4.5:1 auf #111
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

      {/* Claude-Abo (Nutzungsanzeige) — anthropic-oauth-vault AC10/AC11, S-368 */}
      <section aria-labelledby="settings-section-anthropic-oauth" style={styles.section}>
        <h2 id="settings-section-anthropic-oauth" style={styles.sectionHeading}>Claude-Abo (Nutzungsanzeige)</h2>
        <p style={styles.sectionDesc}>
          Abo-OAuth-Credentials für die offizielle Nutzungsanzeige (Prozent-/Reset-Werte in der
          Token-Anzeige). Herkunft: Login mit dem Claude-Abo (interaktive Claude-Code-Anmeldung).
          Die Werte liegen verschlüsselt im Tresor und werden nie im Klartext angezeigt.
        </p>
        {KNOWN_FIELDS['anthropic-oauth'].map(({ name, label }) => (
          <CredentialField
            key={name}
            integration="anthropic-oauth"
            name={name}
            label={label}
            meta={getMeta('anthropic-oauth', name)}
            onSaved={onLoad}
          />
        ))}
        <p style={styles.expiresAtHint}>
          Ablauf Access-Token: {formatAnthropicOAuthExpiresAt(getMeta('anthropic-oauth', 'access_token')?.expiresAt)}
        </p>
      </section>
    </>
  );
}
