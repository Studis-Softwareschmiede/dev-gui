/**
 * CloudInitBuilder — erzeugt server-seitig cloud-init-user-data (ADR-009).
 *
 * ADR-009-Kontrakt: cloud-init/userData wird IMMER server-intern erzeugt.
 * Der Client liefert NIE rohes cloud-init. Diese Boundary sorgt dafür, dass
 * kein untrusted client-controlled cloud-init in Provider-API-Aufrufe fließt.
 *
 * Vorlage-Version: TEMPLATE_VERSION — wird bei strukturellen Änderungen erhöht.
 * Änderungshistorie:
 *   v1 (2026-06-08) — Ubuntu-Update, Docker CE aus offizieller Docker-Apt-Quelle,
 *                     User alex (sudo+docker-Gruppe, bash, SSH-Key via write_files),
 *                     User root (SSH-Key via write_files). [DEFEKT: write_files läuft
 *                     vor runcmd useradd → alex-owner-Block bricht write_files ab →
 *                     kein Key landet; außerdem: Hetzner-Epoch-0-Expire blockiert root]
 *   v2 (2026-06-17) — Benutzer + SSH-Keys via cloud-init-native users:-Sektion
 *                     (behebt write_files/useradd-Race); chage -d -1 root entfernt
 *                     Hetzner-root-Passwort-Expire (Epoch 0). (ADR-009, AC4–AC6, AC9–AC11)
 *
 * @module CloudInitBuilder
 */

/** Aktuelle Vorlage-Version — erhöhen bei jeder strukturellen Änderung. */
export const TEMPLATE_VERSION = 2;

// ── CloudInitBuilder ──────────────────────────────────────────────────────────

export class CloudInitBuilder {
  /**
   * Erzeugt ein vollständiges, versioniertes cloud-init-user-data-Dokument.
   *
   * Enthält:
   *   (a) Ubuntu System-Update (package_update + package_upgrade)
   *   (b) Docker CE aus offizieller Docker-Apt-Quelle (GPG-Key + Repo +
   *       docker-ce docker-ce-cli containerd.io docker-compose-plugin)
   *   (c) User alex: sudo- + docker-Gruppe, Login-Shell bash, SSH-Public-Key
   *       — via cloud-init-native users:-Sektion (ssh_authorized_keys)
   *   (d) User root: SSH-Public-Key — via users:-Sektion (ssh_authorized_keys),
   *       disable_root: false
   *   (e) chage -d -1 root: entfernt Hetzner-Epoch-0-Passwort-Expire (AC10)
   *
   * Security-Floor (AC6 / NFR):
   *   - Nur Public-Keys werden eingebettet; niemals Private-Keys oder Provider-Tokens.
   *   - Public-Keys landen ausschließlich in users:→ssh_authorized_keys
   *     (cloud-init-nativ, kein Shell-Sink in runcmd).
   *
   * @param {object} params
   * @param {string} params.name              - Hostname des Servers (optional; wird
   *                                            als cloud-init-hostname gesetzt, falls angegeben)
   * @param {{ root: string, alex: string }} params.sshPublicKeys
   *   - Distinkte SSH-Public-Keys je User-Rolle (nur Public-Keys, nie Private-Keys).
   * @returns {string} Wohlgeformtes #cloud-config-YAML-Dokument (user-data).
   * @throws {CloudInitError} wenn ein Public-Key für root oder alex fehlt (AC7).
   */
  build({ name, sshPublicKeys } = {}) {
    const { root: rootKey, alex: alexKey } = sshPublicKeys ?? {};

    // AC7 — fehlende Public-Keys → 422-fähiger Fehler vor jedem Provider-Call
    if (!rootKey || typeof rootKey !== 'string' || rootKey.trim() === '') {
      throw new CloudInitError(
        'Fehlender SSH-Public-Key für User root',
        'missing-ssh-key',
        422,
      );
    }
    if (!alexKey || typeof alexKey !== 'string' || alexKey.trim() === '') {
      throw new CloudInitError(
        'Fehlender SSH-Public-Key für User alex',
        'missing-ssh-key',
        422,
      );
    }

    // Public-Keys werden NUR in users:→ssh_authorized_keys eingebettet (kein Shell-Sink).
    // Zur Sicherheit: trimmen; ein echter OpenSSH-Public-Key enthält keine YAML-Sonderzeichen.
    const rootKeyLine = rootKey.trim();
    const alexKeyLine = alexKey.trim();

    // Hostname-Block (optional)
    const hostnameBlock = name ? `hostname: ${sanitizeHostname(name)}\n` : '';

    // Template-Version als Kommentar im Dokument (AC8)
    const doc = `#cloud-config
# cloud-init Default-Setup-Vorlage v${TEMPLATE_VERSION} (CloudInitBuilder, ADR-009)
${hostnameBlock}package_update: true
package_upgrade: true
disable_root: false
users:
  - name: root
    ssh_authorized_keys:
      - ${rootKeyLine}
  - name: alex
    groups: [sudo, docker]
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    ssh_authorized_keys:
      - ${alexKeyLine}
runcmd:
  # Hetzner-root-Passwort-Expire (Epoch 0) entfernen → root-Key-Login non-interaktiv möglich
  - chage -d -1 root
  # Docker CE aus offizieller Quelle (https://docs.docker.com/engine/install/ubuntu/)
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - |
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  - systemctl enable docker
  - systemctl start docker
`;

    return doc;
  }
}

// ── CloudInitError ─────────────────────────────────────────────────────────────

/**
 * Getypter Fehler des CloudInitBuilder.
 * Kein Secret-Material in message (AC6 / security/R01).
 */
export class CloudInitError extends Error {
  /**
   * @param {string} message    - Human-readable (keine Secrets)
   * @param {string} errorClass - Machine-readable ("missing-ssh-key" u.a.)
   * @param {number} [httpStatus] - Empfohlener HTTP-Status für den Create-Pfad
   */
  constructor(message, errorClass, httpStatus) {
    super(message);
    this.name = 'CloudInitError';
    this.errorClass = errorClass;
    this.httpStatus = httpStatus ?? 422;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Begrenzt den Hostname auf sichere cloud-init-YAML-Einbettung:
 * nur alphanumerisch + Bindestrich, max. 63 Zeichen (RFC 1123).
 * Kein Shell-Sink — nur als cloud-init-YAML-Skalarwert verwendet.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeHostname(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'server';
}
