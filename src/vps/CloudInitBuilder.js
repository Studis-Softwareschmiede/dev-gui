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
 *                     User alex (sudo+docker-Gruppe, bash, SSH-Key),
 *                     User root (SSH-Key).
 *
 * @module CloudInitBuilder
 */

/** Aktuelle Vorlage-Version — erhöhen bei jeder strukturellen Änderung. */
export const TEMPLATE_VERSION = 1;

// ── CloudInitBuilder ──────────────────────────────────────────────────────────

export class CloudInitBuilder {
  /**
   * Erzeugt ein vollständiges, versioniertes cloud-init-user-data-Dokument.
   *
   * Enthält:
   *   (a) Ubuntu System-Update (package_update + package_upgrade + apt-get upgrade)
   *   (b) Docker CE aus offizieller Docker-Apt-Quelle (GPG-Key + Repo +
   *       docker-ce docker-ce-cli containerd.io docker-compose-plugin)
   *   (c) User alex: sudo- + docker-Gruppe, Login-Shell bash, SSH-Public-Key
   *   (d) User root: SSH-Public-Key in /root/.ssh/authorized_keys
   *
   * Security-Floor (AC6 / NFR):
   *   - Nur Public-Keys werden eingebettet; niemals Private-Keys oder Provider-Tokens.
   *   - Die Public-Key-Strings werden nicht shell-escaped in runcmd eingebettet;
   *     sie landen nur in write_files-Blöcken (cloud-init-nativ, kein Shell-Sink).
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

    // YAML-Werte müssen für den write_files-content-Block sicher eingebettet werden.
    // Public-Keys landen ausschliesslich in write_files-content (kein Shell-Sink).
    // Zur Sicherheit: Public-Keys dürfen keine YAML-Block-Abschlüsse enthalten —
    // ein echter OpenSSH-Public-Key (Base64 + Kommentar) enthält keine solchen Zeichen.
    const rootKeyLine = rootKey.trim();
    const alexKeyLine = alexKey.trim();

    // Hostname-Block (optional)
    const hostnameBlock = name ? `hostname: ${sanitizeHostname(name)}\n` : '';

    // Template-Version als Kommentar im Dokument (AC8)
    const doc = `#cloud-config
# cloud-init Default-Setup-Vorlage v${TEMPLATE_VERSION} (CloudInitBuilder, ADR-009)
# Erzeugt: Ubuntu-Update, Docker CE (offizielle Quelle), User alex+root mit SSH-Keys.
${hostnameBlock}
# (a) System-Update beim ersten Boot
package_update: true
package_upgrade: true

# (b) Docker CE aus offizieller Docker-Apt-Quelle installieren und starten
# Quelle: https://docs.docker.com/engine/install/ubuntu/
# Nicht: docker.io (veraltetes Distro-Paket)
runcmd:
  # GPG-Key der offiziellen Docker-Apt-Quelle holen
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  # Offizielle Docker-Apt-Quelle eintragen
  - |
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  - apt-get update
  # Docker CE + CLI + containerd + Compose-Plugin installieren (neueste stabile Version)
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  # Docker-Dienst aktivieren und starten
  - systemctl enable docker
  - systemctl start docker
  # (c) User alex anlegen (falls nicht vorhanden), Gruppen setzen, .ssh einrichten
  - id -u alex &>/dev/null || useradd -m -s /bin/bash alex
  - usermod -aG sudo alex
  - usermod -aG docker alex
  - mkdir -p /home/alex/.ssh
  - chmod 700 /home/alex/.ssh
  - chown alex:alex /home/alex/.ssh
  - chown alex:alex /home/alex/.ssh/authorized_keys || true
  # (d) SSH-Verzeichnis für root sicherstellen
  - mkdir -p /root/.ssh
  - chmod 700 /root/.ssh

# (c) SSH-Public-Key für User alex
write_files:
  - path: /home/alex/.ssh/authorized_keys
    permissions: "0600"
    owner: alex:alex
    content: |
      ${alexKeyLine}
  # (d) SSH-Public-Key für User root
  - path: /root/.ssh/authorized_keys
    permissions: "0600"
    owner: root:root
    content: |
      ${rootKeyLine}
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
