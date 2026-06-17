/**
 * tunnelName.js — Hilfsfunktion zur Sanitisierung von VPS-Namen für Tunnel-Namen.
 *
 * Tunnel-Name-Konvention (vps-tunnel-provisioning Spec): `devgui-<sanitized-vpsname>`.
 * Sanitisierung: lowercase, nur [a-z0-9-], max 63 Zeichen (RFC 1123 Hostname-Label).
 *
 * Diese Funktion ist auch für den Deploy-Pfad (S-155) zugänglich —
 * er kann den Tunnel-Namen deterministisch aus dem VPS-Namen ableiten.
 *
 * @module vps/tunnelName
 */

/**
 * Sanitisiert einen VPS-Namen für die Verwendung im Tunnel-Namen-Suffix.
 *
 * Erlaubte Zeichen: lowercase alphanumerisch + Bindestrich (RFC 1123).
 * Führende/abschließende Bindestriche werden entfernt.
 * Max. 63 Zeichen (Cloudflare Tunnel-Name-Limit).
 *
 * @param {string} name - VPS-Name (roh)
 * @returns {string} Sanitisierter Tunnel-Name-Suffix (z.B. "my-server-01")
 */
export function sanitizeTunnelName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'server';
}
