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
 *   v3 (2026-06-18) — (Skip — v3 wurde in der Spec für post-create-SSH-Pfad reserviert;
 *                     cloud-init-Variante startet bei v4.)
 *   v4 (2026-06-18) — cloudflared als Docker-Container via cloud-init (S-152, AC12/AC13).
 *                     Tunnel-Token als Docker env-file (/etc/cloudflared/env, TUNNEL_TOKEN=<wert>,
 *                     0600 root:root) via write_files; cloudflared liest TUNNEL_TOKEN nativ
 *                     aus Docker-Env (--env-file) — Token NICHT in runcmd-Argv/Shell-Log
 *                     (vps-tunnel-provisioning AC6, vps-cloud-init-setup AC13).
 *                     Optionaler Parameter: ohne tunnelToken → kein cloudflared-Block (rückwärtskompatibel).
 *   v5 (2026-06-18) — cloudflared Container im Host-Netzwerk gestartet (--network host, AC14).
 *                     Ohne --network host ist localhost im Container der Container selbst (nicht der Host)
 *                     → Tunnel-Route http://localhost:<hostPort> unerreichbar (live verifiziert, S-170).
 *                     Token-Floor (AC13) bleibt unverändert: Token nur via --env-file, nie in Argv/Log.
 *   v6 (2026-07-27) — optionaler persistierter Ed25519-SSH-Host-Key via cloud-init-natives
 *                     `ssh_keys:` (docs/specs/vps-host-key-stabilitaet.md AC1/AC4, Variante a,
 *                     S-425). `VpsProviderRegistry` erzeugt/liest den Host-Key je Ziel-Name
 *                     einmalig und übergibt ihn hier weiter — er bleibt damit über einen
 *                     Delete+Create-Rebuild desselben Ziels stabil (kein neuer Host-Key, kein
 *                     Fingerprint-Wechsel, kein `ssh-keygen -R` nötig). Ohne sshHostKey (nicht
 *                     übergeben) → kein `ssh_keys:`-Block, cloud-init generiert wie bisher
 *                     eigene Host-Keys beim ersten Boot (rückwärtskompatibel mit v5).
 *
 * @module CloudInitBuilder
 */

/** Aktuelle Vorlage-Version — erhöhen bei jeder strukturellen Änderung. */
export const TEMPLATE_VERSION = 6;

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
   *   (f) cloudflared als Docker-Container (optional, nur wenn tunnelToken übergeben):
   *       Token wird via write_files in /etc/cloudflared/env (0600) abgelegt;
   *       cloudflared liest Token via --env-file (TUNNEL_TOKEN) — NIEMALS Token in Argv/runcmd-Echo
   *       (vps-tunnel-provisioning AC6 / vps-cloud-init-setup AC12/AC13).
   *   (g) Persistierter Ed25519-SSH-Host-Key (optional, nur wenn sshHostKey übergeben):
   *       cloud-init-natives `ssh_keys:` (kein write_files/runcmd-Sink) — der Server bootet
   *       mit GENAU diesem Host-Key statt einen neuen zu generieren (docs/specs/
   *       vps-host-key-stabilitaet.md AC1/AC4, Variante a).
   *
   * Security-Floor (AC6 / vps-cloud-init-setup AC13 / NFR):
   *   - Nur Public-Keys werden in users:→ssh_authorized_keys eingebettet.
   *   - Das Tunnel-Token (wenn übergeben) landet NUR im write_files-YAML-Wert
   *     mit restriktiven Permissions (0600, root:root) — NICHT in runcmd-Argv.
   *   - Docker nutzt das Token ausschließlich via --env-file (TUNNEL_TOKEN) — kein Token in Argv.
   *   - Der SSH-Host-Private-Key (wenn übergeben) landet NUR im `ssh_keys:`-YAML-Wert —
   *     kein write_files/runcmd-Sink, kein Argv, gleiche Vertraulichkeits-Klasse wie der
   *     Tunnel-Token (docs/specs/vps-host-key-stabilitaet.md AC4).
   *   - Das erzeugte cloud-init-Dokument fließt NUR an die Provider-Create-API
   *     (server-privat). Es erscheint nicht im Frontend-Bundle oder in Logs.
   *
   * @param {object} params
   * @param {string} params.name              - Hostname des Servers (optional; wird
   *                                            als cloud-init-hostname gesetzt, falls angegeben)
   * @param {{ root: string, alex: string }} params.sshPublicKeys
   *   - Distinkte SSH-Public-Keys je User-Rolle (nur Public-Keys, nie Private-Keys).
   * @param {string} [params.tunnelToken]
   *   - Cloudflare Tunnel-Token (Geheimnis). Wenn übergeben, wird cloudflared als
   *     Docker-Container eingerichtet. Wenn nicht übergeben → kein cloudflared-Block
   *     (rückwärtskompatibel mit v2).
   *     Security: Token erscheint NICHT in runcmd-Argv — nur als YAML-Wert im
   *     write_files-Block (`/etc/cloudflared/env` als Docker env-file, 0600 Permissions;
   *     cloudflared liest TUNNEL_TOKEN aus Docker-Env ohne argv-Exposition; AC6).
   * @param {{ publicKey: string, privateKey: string }} [params.sshHostKey]
   *   - Persistierter Ed25519-SSH-Host-Key (docs/specs/vps-host-key-stabilitaet.md AC1/AC4).
   *     Wenn übergeben, bootet der Server mit diesem Host-Key (via `ssh_keys:`) statt einen
   *     neuen zu generieren — der Fingerprint bleibt über Rebuilds desselben Ziels stabil.
   *     Wenn nicht übergeben → kein `ssh_keys:`-Block (rückwärtskompatibel mit v5: cloud-init
   *     generiert den Host-Key wie bisher selbst beim ersten Boot).
   * @returns {string} Wohlgeformtes #cloud-config-YAML-Dokument (user-data).
   * @throws {CloudInitError} wenn ein Public-Key für root oder alex fehlt (AC7).
   */
  build({ name, sshPublicKeys, tunnelToken, sshHostKey } = {}) {
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

    // cloudflared-Block: nur wenn tunnelToken übergeben (vps-cloud-init-setup AC12/AC13).
    // Security-Floor: Token landet NUR im write_files-YAML-Wert mit 0600-Permissions.
    // Es erscheint NICHT in runcmd-Argv oder geloggten Shell-Befehlen (AC6).
    //
    // Mechanik (coder-Entscheid S-152, AC6 / vps-cloud-init-setup AC13):
    //   Das Token wird als Docker --env-file übergeben (Datei: /etc/cloudflared/env,
    //   Inhalt: TUNNEL_TOKEN=<wert>). cloudflared liest TUNNEL_TOKEN nativ ohne weiteres Argument.
    //   Damit erscheint das Token NICHT in docker-run-Argv (sichtbar via `ps aux`),
    //   sondern nur im Datei-Inhalt — vor Cloud-init-Logs/Shell-Protokoll geschützt.
    //   Der runcmd-Eintrag ist: docker run ... --env-file /etc/cloudflared/env ...
    //   — kein Token-Wert in der Befehlszeile selbst.
    const hasTunnel = typeof tunnelToken === 'string' && tunnelToken.trim() !== '';
    const writeFilesBlock = hasTunnel
      ? `write_files:
  # Tunnel-Token als Docker env-file (0600 root:root) — NICHT in runcmd-Argv (vps-tunnel-provisioning AC6)
  # Das Token fließt ausschließlich an die Provider-Create-API (server-privat, nie in Logs/Frontend).
  - path: /etc/cloudflared/env
    permissions: '0600'
    owner: 'root:root'
    content: |
      TUNNEL_TOKEN=${tunnelToken.trim()}
`
      : '';

    const cloudflaredRuncmd = hasTunnel
      ? `  # cloudflared als Docker-Container im Host-Netzwerk — Token via --env-file (kein Token in Argv, AC6/AC13/AC14)
  # --network host: localhost im Container = Host-localhost; Route http://localhost:<port> erreichbar (AC14, S-170)
  - docker run -d --name cloudflared --restart unless-stopped --network host --env-file /etc/cloudflared/env cloudflare/cloudflared:latest tunnel --no-autoupdate run
`
      : '';

    // ssh_keys-Block: nur wenn sshHostKey übergeben (docs/specs/vps-host-key-stabilitaet.md
    // AC1/AC4, Variante a). cloud-init-natives Feature (cc_ssh) — kein Eigenbau: generiert für
    // einen Key-Typ NUR dann einen neuen Host-Key, wenn `ssh_keys.<typ>_private` NICHT gesetzt
    // ist; mit gesetztem ed25519_private/ed25519_public bootet der Server mit GENAU diesem
    // Schlüsselpaar statt einem neu generierten → Fingerprint bleibt über einen Rebuild
    // (Delete+Create desselben Ziels durch VpsProviderRegistry) stabil, kein Host-Key-Mismatch.
    // Security-Floor: Private-Key landet NUR im `ssh_keys:`-YAML-Wert (kein write_files/runcmd-
    // Sink, kein Argv) — gleiche Vertraulichkeits-Klasse wie der Tunnel-Token (AC13-Analogie).
    const hasHostKey = sshHostKey
      && typeof sshHostKey.privateKey === 'string' && sshHostKey.privateKey.trim() !== ''
      && typeof sshHostKey.publicKey === 'string' && sshHostKey.publicKey.trim() !== '';
    const sshKeysBlock = hasHostKey
      ? `ssh_keys:
  # Persistierter Ed25519-Host-Key (vps-host-key-stabilitaet AC1/AC4, Variante a) — bleibt über
  # Rebuilds (Delete+Create desselben Ziels) stabil, kein Host-Key-Mismatch im SSH-Terminal.
  ed25519_private: |
${indentBlock(sshHostKey.privateKey.trim(), 4)}
  ed25519_public: ${sshHostKey.publicKey.trim()}
`
      : '';

    // Template-Version als Kommentar im Dokument (AC8)
    const doc = `#cloud-config
# cloud-init Default-Setup-Vorlage v${TEMPLATE_VERSION} (CloudInitBuilder, ADR-009)
${hostnameBlock}${sshKeysBlock}${writeFilesBlock}package_update: true
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
${cloudflaredRuncmd}`;

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

/**
 * Rückt jede Zeile eines mehrzeiligen Textes um `spaces` Leerzeichen ein — für die
 * Einbettung als YAML-Block-Skalar (`|`), z.B. `ssh_keys.ed25519_private` (AC1/AC4).
 * Leere Zeilen bleiben leer (kein trailing Whitespace).
 *
 * @param {string} text
 * @param {number} spaces
 * @returns {string}
 */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}
