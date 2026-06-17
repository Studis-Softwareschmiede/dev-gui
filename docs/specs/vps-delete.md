---
id: vps-delete
title: VPS löschen (DELETE + Tunnel-Cleanup + UI)
status: draft
version: 1
---

# Spec: VPS löschen (`vps-delete`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (destruktive, kostenrelevante Mutation).

## Zweck
Ein VPS kann aus dev-gui **gelöscht** werden — heute existieren nur list/create/start/stop. Das Löschen entfernt den Server beim Provider **und** räumt den zum VPS gehörenden **Cloudflare-Tunnel** ([[vps-tunnel-provisioning]]) inklusive dessen Routen/DNS auf (kein verwaister Tunnel, kein verwaistes Token). Die Aktion ist hoch-privilegiert: hinter der Access-Mauer, identitäts-/rollengeschützt, **audit-first** und im Frontend mit **type-to-confirm** abgesichert.

> **Abgrenzung:** Diese Spec definiert den **DELETE-Endpunkt + Tunnel-Cleanup + Löschen-Button**. Das Anlegen des Tunnels/cloudflared liegt in [[vps-tunnel-provisioning]]; die Provider-Boundary/Token-Quelle in [[vps-provider-boundary]]; die Cloudflare-API-Mutationen (deleteTunnel, removeRoute, deleteDnsRecord) in [[view-cloudflare]]/[[cloudflare-reconciliation]] (Wiederverwendung, kein neuer Cloudflare-API-Sprecher — ADR-010).

## Verhalten
1. **DELETE-Endpunkt:** `DELETE /api/vps/machines/{provider}/{serverId}` löscht den adressierten Server beim Provider. `serverId` kann (IONOS) ein composite `"<datacenterId>/<serverId>"` mit `/` sein — gleiches `*splat`-Routing wie start/stop ([[vps-provider-boundary]]).
2. **Provider-Adapter `deleteServer`:** Der jeweilige Adapter führt das Provider-spezifische Löschen aus. Unterstützt ein Provider programmatisches Löschen API-seitig nicht, meldet der Adapter `result: "unsupported"` (HTTP 422), ohne destruktive Ersatzaktion. Die Capability wird über `GET /api/vps/providers` (`capabilities.delete`) ausgewiesen.
3. **Tunnel-Cleanup:** Beim Löschen wird der zum VPS gehörende Cloudflare-Tunnel ([[vps-tunnel-provisioning]] AC7: Tunnel-ID/Token-Referenz aus der VPS-Zuordnung) aufgeräumt: dessen **Routen/DNS** werden entfernt und der **Tunnel gelöscht** (`CloudflareApi.deleteTunnel` + ggf. `removeRoute`/`deleteDnsRecord`), und die **Token-Referenz** im `CredentialStore` wird entfernt. Cleanup ist **idempotent** (bereits gelöschte Cloudflare-Ressourcen sind kein Fehler) und **best-effort robust** (ein Cloudflare-Cleanup-Fehler verhindert nicht das Server-Löschen, wird aber klar gemeldet/auditiert).
4. **Sicherheit (Floor):** Wie alle VPS-Mutationen — hinter der Access-Mauer, identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik), **audit-first** (Audit-Eintrag VOR Ausführung; schlägt der Audit-Write fehl → Aktion unterbleibt). Provider-/Tunnel-Tokens erscheinen nie in Response/Log/Audit/WS/Argv.
5. **type-to-confirm (UI):** Im Frontend ([[view-vps]]) gibt es pro VPS-Zeile einen **Löschen-Button** (neben Start/Stop). Das Löschen erfordert eine explizite Bestätigung, bei der der Nutzer den **VPS-Namen exakt eintippen** muss (type-to-confirm), bevor `DELETE` ausgelöst wird; ein Tippfehler/Abbruch löst keine Aktion aus.

## Acceptance-Kriterien

### Backend (DELETE + Cleanup)
- **AC1** — `DELETE /api/vps/machines/{provider}/{serverId}` existiert und löscht den adressierten Server beim Provider; composite IONOS-`serverId` mit `/` wird via `*splat` korrekt rekonstruiert (gleiche Routing-/Validierungslogik wie start/stop). Antwort `{ result: "ok"|"unsupported"|"error", reason? }`.
- **AC2** — Der jeweilige Provider-Adapter besitzt eine `deleteServer(serverId, token)`-Methode (neu, falls nicht vorhanden) und ist über `capabilities()` als `delete: true|false` ausgewiesen; ein Provider ohne API-seitiges Löschen liefert `result: "unsupported"` (422), keine destruktive Ersatzaktion.
- **AC3** — Beim Löschen wird der zum VPS gehörende Cloudflare-Tunnel aufgeräumt: Routen/DNS entfernt + `deleteTunnel(tunnelId)` aufgerufen + Token-Referenz aus dem `CredentialStore` entfernt. Cleanup ist **idempotent** (404/„already gone" ist kein Fehler) — kein verwaister Tunnel, kein verwaistes Token.
- **AC4** — Schlägt der Cloudflare-Cleanup fehl, während das Server-Löschen erfolgreich war (oder umgekehrt), wird der Teil-Erfolg klar gemeldet und auditiert; der Cleanup-Fehler maskiert nicht fälschlich einen Server-Lösch-Erfolg/-Fehler (klare `reason`/`errorClass`).
- **AC5** — Existiert keine Tunnel-Zuordnung für den VPS (z.B. vor Paket ① angelegt), läuft das Server-Löschen normal durch und der Tunnel-Cleanup wird übersprungen (kein Fehler).

### Sicherheit & Audit (Floor)
- **AC6** — `DELETE /api/vps/machines/...` ist hinter der Access-Mauer (403 ohne Access) und zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik; 403 ohne Berechtigung).
- **AC7** — Vor dem Löschen wird ein Audit-Eintrag geschrieben (Identität, Provider, serverId, Aktion `vps:delete`, Zeit); schlägt der Audit-Write fehl, unterbleibt die Aktion. Provider-/Tunnel-Tokens erscheinen nie in Response/Log/Audit/WS/Argv.

### Frontend (UI)
- **AC8** — In der VPS-Zeile ([[view-vps]]) gibt es einen **Löschen-Button** neben Start/Stop; er ist disabled/als unsupported markiert, wenn `capabilities.delete` des Providers `false` ist (kein erzwungener Fehleraufruf).
- **AC9** — Das Löschen verlangt eine **type-to-confirm**-Bestätigung: der Nutzer muss den **VPS-Namen exakt** eintippen; stimmt die Eingabe nicht überein, ist der finale Löschen-Button gesperrt und es wird kein `DELETE` gesendet. Abbruch verwirft die Bestätigung folgenlos.
- **AC10** — Die UI spiegelt Lade-/Erfolg-/Fehler-/„nicht unterstützt"-Zustände aus der Backend-Antwort; ein 403 wird als klare „keine Berechtigung"-Meldung behandelt; nach Erfolg verschwindet der VPS aus der Übersicht. Kein Token/Geheimnis erscheint im Frontend.

## Verträge
- **DELETE `/api/vps/machines/{provider}/{serverId}`** → `{ result: "ok"|"unsupported"|"error", reason?, errorClass? }`. `*splat`-Routing + serverId-Validierung wie start/stop ([[vps-provider-boundary]]).
- **`VpsProvider.deleteServer(serverId, token)`** → `{ result: "ok"|"unsupported"|"error", reason? }`; `capabilities()` → `{ list, start, stop, create, delete }` (delete neu).
- **Tunnel-Cleanup:** nutzt `CloudflareApi.deleteTunnel(tunnelId)` (+ `removeRoute`/`deleteDnsRecord` falls Routen vorhanden) und die VPS↔Tunnel-Zuordnung aus [[vps-tunnel-provisioning]] AC7; entfernt zudem die Token-Referenz `credentials/cloudflare/tunnel_token/<tunnelId>`.
- **Token-Quelle:** Provider-Token aus `credentials/vps/<provider>_api_token`; Cloudflare-Token store-intern (ADR-010). Alle Endpunkte hinter AccessGuard; mutierend zusätzlich identitäts-/rollengeprüft + AuditEntry.

## Edge-Cases & Fehlerverhalten
- Provider nicht konfiguriert → 422 `provider-not-configured`, kein Provider-Call.
- Unbekannter `serverId` beim Provider → 404 durchgereicht als `result: "error"`, `errorClass: "not-found"` (idempotent: bereits gelöscht ≈ ok, sofern Provider 404 als „gone" liefert — Verhalten dokumentiert/getestet).
- Provider unterstützt Löschen nicht → 422 `result: "unsupported"`.
- Cloudflare nicht konfiguriert / Tunnel bereits gelöscht → Cleanup übersprungen/idempotent, kein Fehler (AC3/AC5).
- type-to-confirm-Name stimmt nicht → kein `DELETE` (AC9).

## NFRs
- **Sicherheit (Floor, hart):** destruktive, kostenrelevante Mutation — audit-first + identitäts-/rollengeschützt + type-to-confirm; keine Token-Leaks.
- **Resilienz:** Cleanup idempotent + best-effort; Teil-Fehler klar gemeldet (kein stiller Orphan).

## Nicht-Ziele
- Rebuild/Snapshot ([[vps-rebuild-backup]]).
- Bulk-Delete mehrerer VPS in einem Aufruf.
- Undeploy einzelner Apps/Container (Paket ②, [[deploy-lifecycle]]).

## Abhängigkeiten
- [[vps-provider-boundary]] (Boundary, `*splat`-Routing, Token-Quelle, Audit/Authz-Muster).
- [[vps-tunnel-provisioning]] (VPS↔Tunnel-Zuordnung + Token-Referenz für den Cleanup).
- [[view-vps]] (UI-Konsument, Löschen-Button + type-to-confirm).
- [[view-cloudflare]] / [[cloudflare-reconciliation]] (`CloudflareApi.deleteTunnel`/`removeRoute`/`deleteDnsRecord`).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — ADR-009 (VPS-Boundary), ADR-010 (CloudflareApi), ADR-007 (CredentialStore).
