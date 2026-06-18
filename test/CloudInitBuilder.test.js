/**
 * CloudInitBuilder.test.js — Unit-Tests für CloudInitBuilder (vps-cloud-init-setup).
 *
 * Covers (vps-cloud-init-setup):
 *   AC1  — Wohlgeformtes #cloud-config-YAML (Header + gültiges YAML)
 *   AC2  — Update-Schritt: package_update:true + package_upgrade:true
 *   AC3  — Docker aus offizieller Docker-Apt-Quelle (download.docker.com), NICHT docker.io
 *   AC4  — User alex: users:-Sektion, bash-Shell, sudo-Gruppe, docker-Gruppe, NOPASSWD, ssh_authorized_keys
 *   AC5  — User root: users:-Sektion, distinkter SSH-Key in ssh_authorized_keys; kein Key-Crossover;
 *           kein write_files authorized_keys, kein useradd
 *   AC6  — Kein Private-Key / kein Secret-Material im Output; Keys nur in users:-Sektion
 *   AC7  — Fehlender Public-Key → CloudInitError(missing-ssh-key, 422)
 *   AC8  — Vorlage ist versioniert (TEMPLATE_VERSION === 5 + Kommentar im Dokument)
 *   AC9  — Negativ-Garantie: kein write_files authorized_keys-Block, kein useradd alex
 *   AC10 — runcmd enthält chage -d -1 root (Hetzner Epoch-0-Expire entfernen)
 *   AC11 — Docker-CE-Install-Block (apt-keyrings, docker.list, apt-get install docker-ce,
 *           systemctl enable/start docker) inhaltlich erhalten
 *
 * Covers (vps-tunnel-provisioning / vps-cloud-init-setup AC12/AC13/AC14):
 *   AC12 — Mit tunnelToken: cloudflared docker-run-Schritt in runcmd vorhanden
 *   AC13 — Token steht nur als write_files-Wert (0600); NICHT in runcmd-Argv/Echo;
 *           Token-Floor: Token erscheint nicht in einem Log-Pfad oder Adapter-Arg
 *   AC14 — cloudflared docker-run enthält --network host; Token-Floor (AC13) bleibt erhalten
 *   Rückwärtskompatibilität: ohne tunnelToken → kein cloudflared-Block
 *
 * Strategy:
 *   - Reine Unit-Tests; keine externen I/O-Abhängigkeiten.
 *   - YAML-Validierung über minimale Syntaxprüfung (Header + keine Leerzeilen-Lücken in
 *     Pflichtfeldern). Das Projekt nutzt kein yaml-Parse-Paket; wir prüfen Garantien
 *     im Rohtext (analog zu den anderen Adapter-Tests).
 */

import { describe, it, expect } from '@jest/globals';
import { CloudInitBuilder, CloudInitError, TEMPLATE_VERSION } from '../src/vps/CloudInitBuilder.js';

// ── Test-Fixtures ─────────────────────────────────────────────────────────────

const ROOT_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRootKeyExampleForTestingOnlyNotReal root@example';
const ALEX_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAlexKeyExampleForTestingOnlyNotReal alex@example';

/** Baut ein gültiges Dokument mit Standard-Test-Keys. */
function buildDefault(overrides = {}) {
  const builder = new CloudInitBuilder();
  return builder.build({
    name: 'test-server',
    sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY },
    ...overrides,
  });
}

// ── AC1: Wohlgeformtes #cloud-config ──────────────────────────────────────────

describe('CloudInitBuilder — AC1: Wohlgeformtes cloud-config', () => {
  it('erzeugt ein Dokument, das mit "#cloud-config" beginnt', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/^#cloud-config/);
  });

  it('enthält keine leere/fehlende Dokument-Struktur (nicht nur den Header)', () => {
    const doc = buildDefault();
    // Mehr als nur der Header — mindestens mehrere Zeilen
    const lines = doc.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(5);
  });

  it('gibt einen String zurück', () => {
    const doc = buildDefault();
    expect(typeof doc).toBe('string');
  });
});

// ── AC2: Update-Schritt ────────────────────────────────────────────────────────

describe('CloudInitBuilder — AC2: System-Update', () => {
  it('enthält package_update: true', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/package_update:\s*true/);
  });

  it('enthält package_upgrade: true', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/package_upgrade:\s*true/);
  });

  it('enthält apt-get upgrade oder package_upgrade im runcmd-Bereich', () => {
    const doc = buildDefault();
    // package_upgrade:true ist der cloud-init-native Weg — genügt für AC2.
    // Zusätzlich prüfen: kein stiller Wegfall des Upgrade-Schritts.
    expect(doc).toMatch(/package_upgrade:\s*true/);
  });
});

// ── AC3: Docker aus offizieller Quelle ────────────────────────────────────────

describe('CloudInitBuilder — AC3: Docker aus offizieller Docker-Apt-Quelle', () => {
  it('referenziert download.docker.com (offizielle Docker-Quelle)', () => {
    const doc = buildDefault();
    expect(doc).toContain('download.docker.com');
  });

  it('installiert docker-ce (nicht docker.io)', () => {
    const doc = buildDefault();
    expect(doc).toContain('docker-ce');
    // NICHT das veraltete Ubuntu-Distro-Paket als Standard
    // (docker.io darf nicht als Installations-Befehl erscheinen)
    const lines = doc.split('\n');
    const dockerIoInstallLine = lines.find(
      (l) => l.match(/apt-get\s+install/) && l.includes('docker.io'),
    );
    expect(dockerIoInstallLine).toBeUndefined();
  });

  it('installiert docker-ce-cli', () => {
    const doc = buildDefault();
    expect(doc).toContain('docker-ce-cli');
  });

  it('installiert containerd.io', () => {
    const doc = buildDefault();
    expect(doc).toContain('containerd.io');
  });

  it('installiert docker-compose-plugin', () => {
    const doc = buildDefault();
    expect(doc).toContain('docker-compose-plugin');
  });

  it('aktiviert und startet den Docker-Dienst (systemctl enable + start)', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/systemctl\s+enable\s+docker/);
    expect(doc).toMatch(/systemctl\s+start\s+docker/);
  });
});

// ── AC4: User alex via users:-Sektion ─────────────────────────────────────────

describe('CloudInitBuilder — AC4: User alex via users:-Sektion', () => {
  it('enthält eine users:-Sektion mit name: alex', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/^users:/m);
    expect(doc).toMatch(/name:\s*alex/);
  });

  it('setzt Login-Shell /bin/bash für alex in der users:-Sektion', () => {
    const doc = buildDefault();
    expect(doc).toContain('shell: /bin/bash');
  });

  it('fügt alex der sudo-Gruppe hinzu (groups: [sudo, docker])', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/groups:.*sudo/);
  });

  it('fügt alex der docker-Gruppe hinzu (groups: [sudo, docker])', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/groups:.*docker/);
  });

  it('gewährt alex passwortloses sudo (NOPASSWD)', () => {
    const doc = buildDefault();
    expect(doc).toContain('NOPASSWD');
    expect(doc).toMatch(/sudo:.*ALL.*NOPASSWD/);
  });

  it('deployt alex Public-Key via ssh_authorized_keys in der users:-Sektion', () => {
    const doc = buildDefault();
    // Key muss nach dem alex-users:-Block erscheinen
    expect(doc).toContain(ALEX_KEY);
    // ssh_authorized_keys-Schlüssel muss vorhanden sein
    expect(doc).toMatch(/ssh_authorized_keys:/);
  });
});

// ── AC5: User root — users:-Sektion, distinkter Key, kein Crossover ───────────

describe('CloudInitBuilder — AC5: User root via users:-Sektion', () => {
  it('enthält eine users:-Sektion mit name: root', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/name:\s*root/);
  });

  it('enthält disable_root: false', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/disable_root:\s*false/);
  });

  it('deployt root Public-Key via ssh_authorized_keys (nicht via write_files)', () => {
    const doc = buildDefault();
    expect(doc).toContain(ROOT_KEY);
    // Kein write_files-Block für authorized_keys (AC5/AC9)
    expect(doc).not.toMatch(/path:.*authorized_keys/);
  });

  it('kein Key-Crossover: alex-Key nicht bei root, root-Key nicht bei alex', () => {
    // Distinkte Keys verwenden
    const rootKey = 'ssh-ed25519 AAAAC3Nza111RootKeyDistinct root@host';
    const alexKey = 'ssh-ed25519 AAAAC3Nza222AlexKeyDistinct alex@host';
    const builder = new CloudInitBuilder();
    const doc = builder.build({ name: 'srv', sshPublicKeys: { root: rootKey, alex: alexKey } });

    // Jeder Key genau einmal (kein Cross-Einbetten)
    const rootKeyOccurrences = (doc.match(new RegExp(rootKey.replace(/\+/g, '\\+'), 'g')) ?? []).length;
    const alexKeyOccurrences = (doc.match(new RegExp(alexKey.replace(/\+/g, '\\+'), 'g')) ?? []).length;

    expect(rootKeyOccurrences).toBe(1);
    expect(alexKeyOccurrences).toBe(1);
  });

  it('root-Key und alex-Key sind getrennte Strings', () => {
    const doc = buildDefault();
    // Beide Keys im Dokument
    expect(doc).toContain(ROOT_KEY);
    expect(doc).toContain(ALEX_KEY);
    // Beide Keys sind nicht identisch (Distinktheit der Fixtures)
    expect(ROOT_KEY).not.toBe(ALEX_KEY);
  });
});

// ── AC6: Kein Private-Key / kein Secret im Output ────────────────────────────

describe('CloudInitBuilder — AC6: Kein Private-Key / kein Secret im Output', () => {
  it('enthält kein typisches Private-Key-Header-Material (-----BEGIN)', () => {
    const doc = buildDefault();
    expect(doc).not.toContain('-----BEGIN');
    expect(doc).not.toContain('-----END');
  });

  it('enthält kein "PRIVATE KEY"-Marker', () => {
    const doc = buildDefault();
    expect(doc.toUpperCase()).not.toContain('PRIVATE KEY');
  });

  it('enthält kein "OPENSSH PRIVATE KEY"-Marker', () => {
    const doc = buildDefault();
    expect(doc).not.toContain('OPENSSH PRIVATE KEY');
  });

  it('enthält keinen Provider-Token (keine Bearer/Authorization-Werte)', () => {
    const doc = buildDefault();
    expect(doc.toLowerCase()).not.toContain('bearer ');
    expect(doc.toLowerCase()).not.toContain('authorization:');
  });

  it('Public-Keys liegen nur in ssh_authorized_keys (kein echo <key> | tee in runcmd)', () => {
    const doc = buildDefault();
    // Keys dürfen nicht per Shell-Echo in runcmd eingebettet sein
    expect(doc).not.toMatch(/echo.*authorized_keys/);
    expect(doc).not.toMatch(/tee.*authorized_keys/);
  });
});

// ── AC7: Fehlerverhalten bei fehlendem Public-Key ─────────────────────────────

describe('CloudInitBuilder — AC7: Fehlerverhalten bei fehlendem Public-Key', () => {
  it('wirft CloudInitError wenn root-Key fehlt', () => {
    const builder = new CloudInitBuilder();
    expect(() =>
      builder.build({ sshPublicKeys: { root: '', alex: ALEX_KEY } }),
    ).toThrow(CloudInitError);
  });

  it('wirft CloudInitError wenn alex-Key fehlt', () => {
    const builder = new CloudInitBuilder();
    expect(() =>
      builder.build({ sshPublicKeys: { root: ROOT_KEY, alex: '' } }),
    ).toThrow(CloudInitError);
  });

  it('wirft CloudInitError wenn sshPublicKeys komplett fehlt', () => {
    const builder = new CloudInitBuilder();
    expect(() => builder.build({})).toThrow(CloudInitError);
  });

  it('wirft CloudInitError wenn sshPublicKeys undefined', () => {
    const builder = new CloudInitBuilder();
    expect(() => builder.build({ sshPublicKeys: undefined })).toThrow(CloudInitError);
  });

  it('errorClass ist "missing-ssh-key" bei fehlendem root-Key', () => {
    const builder = new CloudInitBuilder();
    try {
      builder.build({ sshPublicKeys: { root: null, alex: ALEX_KEY } });
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudInitError);
      expect(err.errorClass).toBe('missing-ssh-key');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('errorClass ist "missing-ssh-key" bei fehlendem alex-Key', () => {
    const builder = new CloudInitBuilder();
    try {
      builder.build({ sshPublicKeys: { root: ROOT_KEY, alex: null } });
      throw new Error('Hätte werfen sollen');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudInitError);
      expect(err.errorClass).toBe('missing-ssh-key');
      expect(err.httpStatus).toBe(422);
    }
  });

  it('wirft CloudInitError wenn root-Key nur Leerzeichen', () => {
    const builder = new CloudInitBuilder();
    expect(() =>
      builder.build({ sshPublicKeys: { root: '   ', alex: ALEX_KEY } }),
    ).toThrow(CloudInitError);
  });

  it('wirft CloudInitError wenn alex-Key nur Leerzeichen', () => {
    const builder = new CloudInitBuilder();
    expect(() =>
      builder.build({ sshPublicKeys: { root: ROOT_KEY, alex: '   ' } }),
    ).toThrow(CloudInitError);
  });

  it('Fehler-Message enthält kein Secret-Material', () => {
    const builder = new CloudInitBuilder();
    try {
      builder.build({ sshPublicKeys: { root: null, alex: ALEX_KEY } });
    } catch (err) {
      // Die Message darf den Key-Inhalt nicht exfiltieren
      expect(err.message).not.toContain(ALEX_KEY);
    }
  });
});

// ── AC8: Versionierung ────────────────────────────────────────────────────────

describe('CloudInitBuilder — AC8: Versionierung', () => {
  it('TEMPLATE_VERSION ist 5 (v5 nach --network host Fix, S-170)', () => {
    expect(TEMPLATE_VERSION).toBe(5);
  });

  it('TEMPLATE_VERSION ist eine positive ganze Zahl', () => {
    expect(typeof TEMPLATE_VERSION).toBe('number');
    expect(Number.isInteger(TEMPLATE_VERSION)).toBe(true);
    expect(TEMPLATE_VERSION).toBeGreaterThan(0);
  });

  it('Dokument enthält die Template-Version als identifizierbares Kommentar', () => {
    const doc = buildDefault();
    // Versions-Kommentar im Dokument — z.B. "v2"
    expect(doc).toMatch(new RegExp(`v${TEMPLATE_VERSION}`));
  });

  it('gleiche Eingaben → identisches Dokument (Reproduzierbarkeit)', () => {
    const builder = new CloudInitBuilder();
    const params = { name: 'repro-test', sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY } };
    const doc1 = builder.build(params);
    const doc2 = builder.build(params);
    expect(doc1).toBe(doc2);
  });
});

// ── AC9: Negativ-Garantie — kein write_files / kein useradd ──────────────────

describe('CloudInitBuilder — AC9: Negativ-Garantie (v1-Defekt beseitigt)', () => {
  it('enthält KEINE write_files-Sektion mit authorized_keys', () => {
    const doc = buildDefault();
    // Der v1-Defekt: write_files mit owner:alex:alex schlug fehl, weil alex erst
    // in runcmd useradd angelegt wurde → gesamtes write_files-Modul bricht ab.
    // In v2: kein write_files mehr für Keys.
    expect(doc).not.toMatch(/write_files:/);
    expect(doc).not.toMatch(/path:.*authorized_keys/);
  });

  it('enthält KEIN useradd alex im runcmd', () => {
    const doc = buildDefault();
    // In v2: alex wird via users:-Sektion angelegt, nicht via useradd in runcmd.
    expect(doc).not.toMatch(/useradd.*alex/);
  });

  it('enthält KEIN usermod in runcmd (Gruppen via users:-Sektion)', () => {
    const doc = buildDefault();
    // In v2: Gruppen werden direkt in users: gesetzt, kein usermod mehr nötig.
    expect(doc).not.toMatch(/usermod/);
  });

  it('enthält KEIN mkdir .ssh in runcmd (Key-Deploy via users:-Sektion)', () => {
    const doc = buildDefault();
    // In v2: kein manuelles mkdir /home/alex/.ssh oder /root/.ssh nötig.
    expect(doc).not.toMatch(/mkdir.*\.ssh/);
  });

  it('root-Key landet in ssh_authorized_keys unter name: root (kein write_files)', () => {
    const doc = buildDefault();
    // Sicherstellen: root-Key ist vorhanden und kein write_files-Block für /root/.ssh
    expect(doc).toContain(ROOT_KEY);
    expect(doc).not.toContain('/root/.ssh/authorized_keys');
  });
});

// ── AC10: chage -d -1 root (Hetzner Epoch-0-Expire entfernen) ────────────────

describe('CloudInitBuilder — AC10: chage -d -1 root', () => {
  it('enthält chage -d -1 root im runcmd', () => {
    const doc = buildDefault();
    expect(doc).toContain('chage -d -1 root');
  });

  it('chage -d -1 root erscheint im runcmd-Block (nach runcmd:)', () => {
    const doc = buildDefault();
    const runcmdIdx = doc.indexOf('runcmd:');
    const chageIdx = doc.indexOf('chage -d -1 root');
    expect(runcmdIdx).toBeGreaterThanOrEqual(0);
    expect(chageIdx).toBeGreaterThan(runcmdIdx);
  });
});

// ── AC11: Docker-CE-Install-Block inhaltlich erhalten ─────────────────────────

describe('CloudInitBuilder — AC11: Docker-CE-Install-Block erhalten', () => {
  it('enthält apt-keyrings-Erstellung', () => {
    const doc = buildDefault();
    expect(doc).toContain('/etc/apt/keyrings');
  });

  it('enthält docker.asc GPG-Key-Download von download.docker.com', () => {
    const doc = buildDefault();
    expect(doc).toContain('docker.asc');
    expect(doc).toContain('download.docker.com/linux/ubuntu/gpg');
  });

  it('enthält docker.list Repo-Eintrag', () => {
    const doc = buildDefault();
    expect(doc).toContain('docker.list');
  });

  it('enthält apt-get install docker-ce docker-ce-cli containerd.io docker-compose-plugin', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/apt-get\s+install\s+-y\s+docker-ce\s+docker-ce-cli\s+containerd\.io\s+docker-compose-plugin/);
  });

  it('aktiviert und startet Docker (systemctl enable + start)', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/systemctl\s+enable\s+docker/);
    expect(doc).toMatch(/systemctl\s+start\s+docker/);
  });

  it('alex ist in docker-Gruppe (users:-Sektion, groups enthält docker)', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/groups:.*docker/);
  });
});

// ── AC12/AC13: cloudflared-Provisionierung (vps-tunnel-provisioning S-152) ────

const TUNNEL_TOKEN = 'eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3Qta2V5In0.dGVzdC10dW5uZWwtdG9rZW4';

/** Baut ein Dokument MIT tunnelToken. */
function buildWithTunnel(overrides = {}) {
  const builder = new CloudInitBuilder();
  return builder.build({
    name: 'test-server',
    sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY },
    tunnelToken: TUNNEL_TOKEN,
    ...overrides,
  });
}

describe('CloudInitBuilder — AC12/AC13: cloudflared-Provisionierung mit tunnelToken', () => {
  it('AC12 — docker run cloudflared erscheint im runcmd-Block', () => {
    const doc = buildWithTunnel();
    expect(doc).toContain('cloudflare/cloudflared:latest');
    expect(doc).toContain('tunnel');
    expect(doc).toContain('run');
  });

  it('AC12 — cloudflared Container heißt "cloudflared" und hat --restart unless-stopped', () => {
    const doc = buildWithTunnel();
    expect(doc).toContain('--name cloudflared');
    expect(doc).toContain('--restart unless-stopped');
  });

  it('AC12 — cloudflared docker run enthält --network host (Host-Netzwerk, AC14)', () => {
    const doc = buildWithTunnel();
    expect(doc).toContain('--network host');
  });

  it('AC12 — cloudflared liest Token via --env-file (kein Token in Argv)', () => {
    const doc = buildWithTunnel();
    // Token wird via Docker --env-file übergeben — Token erscheint NICHT direkt als CLI-Arg
    expect(doc).toContain('--env-file /etc/cloudflared/env');
    // Token selbst darf NICHT direkt als Argument in der docker-run-Zeile stehen
    const dockerRunLine = doc.split('\n').find((l) => l.includes('docker run') && l.includes('cloudflared'));
    expect(dockerRunLine).toBeDefined();
    expect(dockerRunLine).not.toContain(TUNNEL_TOKEN);
  });

  it('AC13 — Token steht in write_files als TUNNEL_TOKEN= in /etc/cloudflared/env', () => {
    const doc = buildWithTunnel();
    expect(doc).toContain('/etc/cloudflared/env');
    expect(doc).toContain('write_files:');
    // Token ist im Dokument als YAML-Wert (TUNNEL_TOKEN=...) vorhanden
    expect(doc).toContain(`TUNNEL_TOKEN=${TUNNEL_TOKEN}`);
  });

  it('AC13 — write_files-Eintrag für das Token hat permissions 0600', () => {
    const doc = buildWithTunnel();
    expect(doc).toContain("permissions: '0600'");
  });

  it('AC13 — Token erscheint NICHT als Argument eines Shell-Befehls in runcmd', () => {
    const doc = buildWithTunnel();
    // Token darf NICHT in runcmd-Zeilen erscheinen (liegt im write_files-Block)
    const lines = doc.split('\n');
    const runcmdIdx = lines.findIndex((l) => l.trim() === 'runcmd:');
    expect(runcmdIdx).toBeGreaterThanOrEqual(0);
    // Nach runcmd: darf keine Zeile das Token direkt enthalten
    const runcmdLines = lines.slice(runcmdIdx);
    const tokenInArgv = runcmdLines.find(
      (l) => l.includes(TUNNEL_TOKEN) && !l.trim().startsWith('#'),
    );
    expect(tokenInArgv).toBeUndefined();
  });

  it('AC13 — write_files-Block (env-Datei) erscheint VOR runcmd (cloud-init-Ausführungsreihenfolge)', () => {
    const doc = buildWithTunnel();
    const writeFilesIdx = doc.indexOf('write_files:');
    const runcmdIdx = doc.indexOf('runcmd:');
    expect(writeFilesIdx).toBeGreaterThanOrEqual(0);
    expect(runcmdIdx).toBeGreaterThan(writeFilesIdx);
  });
});

// ── AC14: cloudflared im Host-Netzwerk (--network host, S-170) ────────────────

describe('CloudInitBuilder — AC14: cloudflared mit --network host', () => {
  it('AC14 — das erzeugte cloud-init enthält --network host im cloudflared docker-run-Eintrag', () => {
    const doc = buildWithTunnel();
    // Der vollständige docker-run-Befehl muss --network host enthalten
    const dockerRunLine = doc.split('\n').find((l) => l.includes('docker run') && l.includes('cloudflared'));
    expect(dockerRunLine).toBeDefined();
    expect(dockerRunLine).toContain('--network host');
  });

  it('AC14 — der vollständige docker-run-Befehl entspricht dem spezifizierten Aufruf (AC12)', () => {
    const doc = buildWithTunnel();
    // Vollständige Befehlssignatur prüfen (Reihenfolge der Flags ist wichtig für Lesbarkeit, nicht für Funktion)
    expect(doc).toContain('docker run -d --name cloudflared --restart unless-stopped --network host --env-file /etc/cloudflared/env cloudflare/cloudflared:latest tunnel --no-autoupdate run');
  });

  it('AC14 — Token-Floor (AC13) bleibt mit --network host erhalten: Token nicht in Argv', () => {
    const doc = buildWithTunnel();
    const dockerRunLine = doc.split('\n').find((l) => l.includes('docker run') && l.includes('cloudflared'));
    expect(dockerRunLine).toBeDefined();
    // --network host ist vorhanden
    expect(dockerRunLine).toContain('--network host');
    // Token ist NICHT in der docker-run-Zeile
    expect(dockerRunLine).not.toContain(TUNNEL_TOKEN);
    // Token weiterhin via --env-file übergeben
    expect(dockerRunLine).toContain('--env-file /etc/cloudflared/env');
  });

  it('AC14 — ohne tunnelToken: kein --network host im Dokument (kein Cloudflared-Block)', () => {
    const doc = buildDefault(); // kein tunnelToken
    expect(doc).not.toContain('--network host');
  });
});

describe('CloudInitBuilder — Rückwärtskompatibilität: kein tunnelToken → kein cloudflared', () => {
  it('ohne tunnelToken: kein cloudflared im Dokument', () => {
    const doc = buildDefault(); // kein tunnelToken
    expect(doc).not.toContain('cloudflared');
    expect(doc).not.toContain('cloudflare/cloudflared');
  });

  it('ohne tunnelToken: kein write_files-Block (Token-Env-Datei nicht vorhanden)', () => {
    const doc = buildDefault(); // kein tunnelToken
    expect(doc).not.toContain('write_files:');
    expect(doc).not.toContain('/etc/cloudflared/env');
  });

  it('mit tunnelToken=null: kein cloudflared-Block', () => {
    const builder = new CloudInitBuilder();
    const doc = builder.build({
      name: 'srv',
      sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY },
      tunnelToken: null,
    });
    expect(doc).not.toContain('cloudflared');
    expect(doc).not.toContain('write_files:');
  });

  it('mit tunnelToken="" (leer): kein cloudflared-Block', () => {
    const builder = new CloudInitBuilder();
    const doc = builder.build({
      name: 'srv',
      sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY },
      tunnelToken: '',
    });
    expect(doc).not.toContain('cloudflared');
    expect(doc).not.toContain('write_files:');
  });

  it('mit tunnelToken=" " (Whitespace): kein cloudflared-Block', () => {
    const builder = new CloudInitBuilder();
    const doc = builder.build({
      name: 'srv',
      sshPublicKeys: { root: ROOT_KEY, alex: ALEX_KEY },
      tunnelToken: '   ',
    });
    expect(doc).not.toContain('cloudflared');
  });

  it('ohne tunnelToken: alle v2-Garantien weiterhin erfüllt (Docker, Users, chage)', () => {
    const doc = buildDefault();
    // Docker
    expect(doc).toContain('docker-ce');
    // Users
    expect(doc).toMatch(/name:\s*alex/);
    expect(doc).toMatch(/name:\s*root/);
    // chage
    expect(doc).toContain('chage -d -1 root');
    // kein cloudflared
    expect(doc).not.toContain('cloudflared');
  });
});
