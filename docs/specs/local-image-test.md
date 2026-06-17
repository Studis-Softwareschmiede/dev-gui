---
id: local-image-test
title: Lokaler Image-Test — gewähltes ghcr-Image+Tag vor VPS-Deploy lokal probestarten
status: draft
version: 1
---

# Spec: Lokaler Image-Test (`local-image-test`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Lokaler Docker-Zugriff über den bestehenden socket-proxy-Pfad (`DOCKER_HOST`); ephemerer Wegwerf-Container, der **immer** aufgeräumt wird.

## Zweck
**Paket ② Deployment-Flow, Sicherheits-Vorstufe:** bevor ein gewähltes ghcr-Image+Tag auf einen VPS deployt wird ([[deploy-lifecycle]], S-155), kann es **lokal** auf dem dev-gui-Host (über den socket-proxy) als **Test-Container** probegestartet werden — Start-Status + erkannter Port werden geprüft, eine Best-Effort-HTTP-Erreichbarkeit gemessen, das Ergebnis angezeigt und der Test-Container danach **garantiert wieder entfernt**. So wird „läuft das Image überhaupt?" geklärt, bevor ein VPS angefasst wird.

## Verhalten
1. Das Backend stellt einen **lokalen Probelauf** bereit: zu `{image, tag}` wird das Image lokal gepullt (über den socket-proxy, `DOCKER_HOST`), ein **kurzlebiger** Container gestartet (mit erkennbarem Test-Label, z.B. `dev-gui.local-test`), der Start-Status ermittelt, der/die exponierte(n) Port(s) per `docker inspect` (ExposedPorts) gelesen, eine Best-Effort-HTTP-Reachability-Probe gegen den gemappten Host-Port versucht, und der Container **anschließend immer** entfernt (`rm -f`) — auch bei Fehler oder Timeout (try/finally-Garantie).
2. **Schreibend-lokaler Docker-Zugriff** (`run`/`inspect`/`rm` lokal) liegt in **genau einer** Boundary; der bestehende read-only `DockerReader` bleibt unberührt. Der Wegwerf-Container ist über sein Test-Label eindeutig identifizierbar und wird nie mit einem produktiven Preview-/Deploy-Container verwechselt.
3. **Port-Ermittlung** spiegelt den VPS-Pfad ([[deploy-lifecycle]]): aus `docker inspect` ExposedPorts wird der Container-Port gelesen; **genau ein** exponierter Port → dieser; **mehrere** → der erste/kleinste wird probiert und die Mehrdeutigkeit im Ergebnis vermerkt; **keiner** → kein Reachability-Versuch, Ergebnis vermerkt „kein exponierter Port" (kein Fehlschlag des gesamten Tests allein deswegen).
4. **Reachability** ist **best-effort**: ein HTTP-GET gegen `http://127.0.0.1:<hostPort>` mit kurzem Timeout; jeder HTTP-Statuscode (auch 4xx/5xx) gilt als „Port antwortet". Timeout/Connection-Refused → „nicht erreichbar" (kein Test-Crash). Die Reachability ist **informativ**, nicht das alleinige Erfolgskriterium.
5. **Ergebnis** ist ein strukturierter Report `{ started, exitedEarly, hostPort, exposedPorts, reachable, durationMs, reason? }`; nach Antwort existiert **kein** Test-Container mehr (Aufräum-Garantie, AC4).
6. **Sicherheit:** der Endpunkt liegt hinter Access; der lokale Probelauf ist eine privilegierte Aktion (identitäts-/rollengeschützt analog Deploy-Mutationen, audit-first), denn er pullt + startet beliebige (Org-)Images lokal. Keine Secrets/Tokens in Response/Log/WS.

## Acceptance-Kriterien

### Boundary & Probelauf
- **AC1** — Schreibend-lokaler Docker-Zugriff (`run`/`inspect`/`rm`) für den Probelauf liegt in **genau einer** Boundary (Grep-prüfbar); der read-only `DockerReader` wird **nicht** verändert. Der Test-Container trägt ein eindeutiges Test-Label (z.B. `dev-gui.local-test`).
- **AC2** — `POST /api/deployments/local-test {image, tag}` pullt das Image lokal, startet einen kurzlebigen Container, ermittelt Start-Status + ExposedPorts und liefert `{ result: "ok", report }` mit dem strukturierten Report. Bei erfolgreichem Start ist `report.started === true`.

### Port & Reachability
- **AC3** — Der/die exponierte(n) Port(s) werden per `docker inspect` (ExposedPorts) ermittelt: genau ein Port → `hostPort` gesetzt + Reachability-Probe; mehrere Ports → erster probiert, `exposedPorts` listet alle, Mehrdeutigkeit im `report` vermerkt; kein Port → `hostPort: null`, keine Probe, `report.reason` benennt „kein exponierter Port". Reachability ist best-effort: jeder HTTP-Statuscode → `reachable: true`; Timeout/Refused → `reachable: false`; **kein** Test-Crash dadurch.

### Aufräum-Garantie & Sicherheit (Floor)
- **AC4** — Der Test-Container wird **immer** entfernt (`rm -f`) — bei Erfolg, bei Image-Pull-Fehler, bei Start-Fehler, bei Reachability-Timeout und bei Exception (try/finally). Testbar: nach jedem Endpunkt-Aufruf existiert **kein** Container mit dem Test-Label mehr.
- **AC5** — `POST /api/deployments/local-test` liegt hinter Access **und** ist identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik, 403 ohne Berechtigung) **und** audit-first (Audit-Eintrag mit Identität/image/tag VOR Pull/Start; schlägt Audit fehl → keine Aktion). `image`/`tag` werden validiert (ghcr-Referenz-/Tag-Zeichensatz, kein Shell-Metazeichen vor dem Docker-Sink); kein Secret/Token in Response/Log/WS.

## Verträge
> Lokaler Docker-Zugriff über den socket-proxy (`DOCKER_HOST`), analog der bestehenden lokalen Docker-Linie; **nicht** der VPS-SSH-Pfad ([[deploy-lifecycle]] / `VpsDockerControl`).

- **`LocalTestReport`:** `{ started: boolean, exitedEarly: boolean, hostPort: number|null, exposedPorts: number[], reachable: boolean, durationMs: number, reason?: string }`.
- **POST `/api/deployments/local-test`** — Body `{ image, tag }` → `200 { result: "ok", report: LocalTestReport }` · `400 { error }` (ungültige image/tag) · `403 { error }` (keine Berechtigung) · `500 { error }` (Audit-Write fehlgeschlagen) · `502 { result: "error", reason }` (Pull/Start-Fehler — Container trotzdem aufgeräumt).
- **`image`/`tag`-Validierung:** image = ghcr-Referenz-Zeichensatz (`^[A-Za-z0-9._/:-]+$`, Längenlimit), tag = `^[A-Za-z0-9._-]+$`; die vollständige Referenz `image:tag` wird **als Argv-Element** (nicht via Shell) an Docker übergeben.
- **Test-Label-Konvention:** `dev-gui.local-test` (+ pro Aufruf eindeutiger Suffix/Name), Filter-/Aufräum-Anker.
- **Port-Quelle:** `docker inspect` `Config.ExposedPorts`; Host-Port = erste freie ab einem Basis-Port (lokal, ephemeral) bzw. ephemeres Port-Mapping; nach dem Test freigegeben (Container weg).
- Hinter AccessGuard; Mutation zusätzlich identitäts-/rollengeprüft + AuditEntry (image/tag).

## Edge-Cases & Fehlerverhalten
- Image-Pull schlägt fehl (ghcr `denied`/nicht vorhanden) → kein Container, `502 { result: "error", reason }`; nichts aufzuräumen, aber Aufräum-Schritt läuft trotzdem idempotent durch.
- Container startet und beendet sich sofort (Crash-Loop / nicht-langläufige Images) → `started: true, exitedEarly: true`, `reachable: false`, Container wird entfernt; klare Auskunft im `report`.
- Image ohne exponierten Port (z.B. CLI-/Job-Image) → `hostPort: null`, keine Reachability, `report.reason` benennt es; **kein** Fehlschlag allein deswegen (AC3).
- Reachability-Timeout / Connection-Refused → `reachable: false`, Test gilt als durchgeführt (Start ok), Container aufgeräumt.
- Lokaler Docker (socket-proxy) nicht erreichbar → `502 { result: "error", reason }`, kein Leak.
- Paralleler Doppel-Aufruf desselben Image → eindeutige Container-Namen pro Aufruf (kein Konflikt); jeder räumt seinen eigenen Test-Container auf.

## NFRs
- **Sicherheit (Floor, hart):** hinter Access, identitäts-/rollengeschützt, audit-first; image/tag validiert vor dem Docker-Sink (kein Command-Injection); keine Secrets/Tokens in Response/Log/WS; **kein** Mount sensibler Host-Pfade/Volumes in den Test-Container.
- **Aufräumen (hart):** kein verwaister Test-Container nach einem Aufruf — try/finally-Garantie (AC4); Wegwerf-Container, keine Persistenz/kein Restart-Policy.
- **Performance:** kurzer Timeout für Pull/Start/Reachability; der Probelauf darf den always-on dev-gui-Prozess nicht blockieren (asynchron, zeitbegrenzt).

## Nicht-Ziele
- VPS-Deploy selbst (→ [[deploy-lifecycle]] / S-155).
- Vollwertiger Smoke-/Integrationstest der App-Funktion (nur „startet + Port antwortet").
- Image-Liste/Tags (→ [[ghcr-image-list]] / S-154).
- Dauerhafte lokale Container / lokale Preview-Verwaltung (read-only `DockerReader` bleibt zuständig fürs Listen).

## Abhängigkeiten
- [[ghcr-image-list]] (liefert image+tag-Auswahl, S-154).
- [[deploy-lifecycle]] (UI-Einbettung „Lokal testen" vor „Deploy auf VPS", S-155).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — lokaler Docker-Zugriff via socket-proxy (`DOCKER_HOST`); read-only `DockerReader`-Boundary bleibt getrennt.
