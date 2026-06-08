/**
 * CloudInitBuilder — erzeugt server-seitig cloud-init-user-data (ADR-009).
 *
 * ADR-009-Kontrakt: cloud-init/userData wird IMMER server-intern erzeugt.
 * Der Client liefert NIE rohes cloud-init. Diese Boundary sorgt dafür, dass
 * kein untrusted client-controlled cloud-init in Provider-API-Aufrufe fließt.
 *
 * CLOUDINIT_STUB_98: Diese Datei ist ein Stub. Die vollständige, versionierte
 * cloud-init-Vorlage (Ubuntu-Update, Docker-Install, User-Konfiguration) wird
 * in Item #98 (vps-cloud-init-setup) implementiert. Bis dahin liefert build()
 * ein minimales valides #cloud-config-Dokument zurück.
 *
 * @module CloudInitBuilder
 */

// ── CloudInitBuilder ──────────────────────────────────────────────────────────

export class CloudInitBuilder {
  /**
   * Erzeugt ein cloud-init-user-data-Dokument server-seitig.
   *
   * CLOUDINIT_STUB_98: Aktuell minimaler Stub; vollständige Vorlage folgt in #98.
   *
   * @param {object} _params - Fachliche Parameter (Provider, Region, Image usw.)
   *   In #98 werden diese Parameter zur Vorlagenanpassung genutzt.
   * @returns {string} Ein valides #cloud-config-YAML-Dokument.
   */
  build(_params = {}) {
    // CLOUDINIT_STUB_98: Minimales leeres cloud-config — keine client-controlled Daten.
    // Item #98 (vps-cloud-init-setup) ersetzt diesen Stub durch die vollständige
    // versionierte Vorlage (Ubuntu-Update, Docker-Install, User-Setup).
    return '#cloud-config\n';
  }
}
