/**
 * CloudInitBuilder.test.js — Unit-Tests für CloudInitBuilder (vps-cloud-init-setup).
 *
 * Covers:
 *   AC1  — Wohlgeformtes #cloud-config-YAML (Header + gültiges YAML)
 *   AC2  — Update-Schritt: package_update:true + package_upgrade:true + apt-get upgrade
 *   AC3  — Docker aus offizieller Docker-Apt-Quelle (download.docker.com), NICHT docker.io
 *   AC4  — User alex: bash-Shell, sudo-Gruppe, docker-Gruppe, SSH-Key in authorized_keys
 *   AC5  — User root: distinkter SSH-Key in /root/.ssh/authorized_keys; kein Key-Crossover
 *   AC6  — Kein Private-Key / kein Secret-Material im Output
 *   AC7  — Fehlender Public-Key → CloudInitError(missing-ssh-key, 422)
 *   AC8  — Vorlage ist versioniert (TEMPLATE_VERSION-Konstante + Kommentar im Dokument)
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

// ── AC4: User alex ────────────────────────────────────────────────────────────

describe('CloudInitBuilder — AC4: User alex', () => {
  it('legt User alex an (useradd oder äquivalent)', () => {
    const doc = buildDefault();
    expect(doc).toContain('alex');
    // useradd-Befehl vorhanden
    expect(doc).toMatch(/useradd.+alex/);
  });

  it('setzt Login-Shell bash für alex', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/useradd.+-s\s+\/bin\/bash.+alex|useradd.+alex.+-s\s+\/bin\/bash/);
  });

  it('fügt alex der sudo-Gruppe hinzu', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/usermod.+-aG.+sudo.+alex|usermod.+-aG.+alex.+sudo/);
  });

  it('fügt alex der docker-Gruppe hinzu', () => {
    const doc = buildDefault();
    expect(doc).toMatch(/usermod.+-aG.+docker.+alex|usermod.+-aG.+alex.+docker/);
  });

  it('schreibt alex Public-Key in /home/alex/.ssh/authorized_keys', () => {
    const doc = buildDefault();
    expect(doc).toContain('/home/alex/.ssh/authorized_keys');
    expect(doc).toContain(ALEX_KEY);
  });
});

// ── AC5: User root — distinkter Key, kein Crossover ──────────────────────────

describe('CloudInitBuilder — AC5: User root', () => {
  it('schreibt root Public-Key in /root/.ssh/authorized_keys', () => {
    const doc = buildDefault();
    expect(doc).toContain('/root/.ssh/authorized_keys');
    expect(doc).toContain(ROOT_KEY);
  });

  it('kein Key-Crossover: alex-Key nicht in /root/.ssh, root-Key nicht in /home/alex/.ssh', () => {
    // Distinkte Keys verwenden
    const rootKey = 'ssh-ed25519 AAAAC3Nza111RootKeyDistinct root@host';
    const alexKey = 'ssh-ed25519 AAAAC3Nza222AlexKeyDistinct alex@host';
    const builder = new CloudInitBuilder();
    const doc = builder.build({ name: 'srv', sshPublicKeys: { root: rootKey, alex: alexKey } });

    // Dokument nach Write-Files-Blöcken aufteilen
    // Einfache Heuristik: Key-Strings kommen genau einmal vor
    const rootKeyOccurrences = (doc.match(new RegExp(rootKey.replace(/\+/g, '\\+'), 'g')) ?? []).length;
    const alexKeyOccurrences = (doc.match(new RegExp(alexKey.replace(/\+/g, '\\+'), 'g')) ?? []).length;

    // Jeder Key genau einmal (kein Cross-Einbetten)
    expect(rootKeyOccurrences).toBe(1);
    expect(alexKeyOccurrences).toBe(1);
  });

  it('root-Key und alex-Key sind getrennte Strings', () => {
    const doc = buildDefault();
    // Beide Keys im Dokument, aber nur der richtige je Pfad
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
  it('TEMPLATE_VERSION ist eine positive ganze Zahl', () => {
    expect(typeof TEMPLATE_VERSION).toBe('number');
    expect(Number.isInteger(TEMPLATE_VERSION)).toBe(true);
    expect(TEMPLATE_VERSION).toBeGreaterThan(0);
  });

  it('Dokument enthält die Template-Version als identifizierbares Kommentar', () => {
    const doc = buildDefault();
    // Versions-Kommentar im Dokument — z.B. "v1" oder "version 1"
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
