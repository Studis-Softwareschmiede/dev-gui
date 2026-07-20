---
id: red-team-tile
title: Red-Team-Kachel — dünner Auslöser für die autorisierte Angriffs-Fähigkeit der Fabrik
status: draft
area: fabrik-arbeiten
version: 1
---

# Red-Team-Kachel

> Cross-Repo-Gegenstück zur agent-flow-Fähigkeit `/agent-flow:red-team` (Rahmen dort:
> `docs/architecture/red-team-subsystem.md` §6). Dünner Auslöser im dev-gui-Panel, **gesamte Logik in der Fabrik** —
> exakt das Muster des Reconcile-Buttons (`headless-reconcile-runner.md`). Feature: F-090.

## Kontext & Motivation

Die Fabrik hat mit `/agent-flow:red-team` eine Fähigkeit, autorisierte eigene Apps zu testen und die Funde in den
Sicherheits-Lernkreis zu speisen. Es fehlt der **Auslöser** im dev-gui. Diese Kachel liefert ihn — analog zum
Reconcile-Button: Ziel wählen (aus einer **konstruktiv erzwungenen Allowlist**), Lauf starten (Headless-Runner,
`claude -p`), Ergebnis + Protokoll-PR anzeigen.

**Sicherheits-Grenze (aus dem agent-flow-Rahmen §6):** die Fabrik-Fähigkeit ist in ihrer aktuellen Iteration ein
**Trockenlauf/Gerüst** (kein realer Live-Angriff; das Feuer-Freigabe-Gate ist HART). Die Kachel triggert genau diese
Fähigkeit — sie feuert **nicht** selbst und konfiguriert Cloudflare **nicht** um. Die Feuer-Freigabe ist eine
**explizite menschliche Bestätigung** in der Kachel; die echte Live-Scanner-Integration + Cloudflare-Koordination
sind der Ausbauschritt danach.

## Allowlist — konstruktiv erzwungen (kein Freitext-Ziel)

Zulässige Ziele = **Schnittmenge**: „läuft als Container auf dem eigenen VPS" (`vpsDockerControl.psAll`, `state === 'running'`)
∩ „ist ein eigenes Repo im Workspace" (`workspaceScanner.listClones()`). Der Client bietet **nur** diese Schnittmenge
zur Auswahl an; das Backend prüft die Auswahl **erneut** gegen dieselbe Schnittmenge (Defense in Depth, `security/R04`
Default-deny) — ein Ziel ausserhalb → **403**, kein Lauf.

## API-Vertrag (verbindlich — Grundlage für Parallel-Bau)

- **`GET /api/red-team/targets`** → `200 { targets: [{ slug, image, state, repo }] }` — die Allowlist-Schnittmenge
  (VPS-laufend ∩ eigenes Repo). Leere Liste (`targets: []`) ist gültig (nichts autorisiert).
- **`POST /api/red-team`** Body `{ projectSlug: string, modus?: "durch-cloudflare"|"direkt"|"beide" }`
  - `202 { jobId, status: "running" }` — Job gestartet
  - `400 { error }` — fehlender/ungültiger/Traversal-Slug (Slug→Pfad wie `reconcileRouter`)
  - `403 { error }` — `projectSlug` **nicht** in der Allowlist-Schnittmenge (Default deny)
  - `409 { error }` — bereits ein laufender Red-Team-Job für dieses Projekt (Projekt-Sperre)
- **`GET /api/red-team/:jobId`** → `200 { status, result?, error?, prHint? }` — `status ∈ {running, done, failed, auth-expired}`;
  `404 { error }` bei unbekannter jobId. (identisch zum Reconcile-Status-Muster)

`modus` default `beide`. Das Backend reicht `ziel=<projectSlug> [modus=<modus>]` als Per-Lauf-Argumente an den
`claude -p /agent-flow:red-team`-Prozess durch (Array-argv, kein Shell-String — `security/R03`).

## Akzeptanzkriterien

- **AC1 — Runner.** `src/HeadlessRedTeamRunner.js`: dünner Wrapper um `HeadlessRunnerCore` (wie `HeadlessReconcileRunner`),
  fest verdrahteter Befehl `/agent-flow:red-team`, eigener Timeout-Default aus `RED_TEAM_TIMEOUT_MS`
  (Default 15 min). `start(projectPath, { ziel, modus })` reicht `args: ['ziel=<ziel>'(, 'modus=<modus>')]` an den Core.
  Kein Import von `PtyManager`/`CommandService` (getrennter Headless-Pfad, wie Reconcile AC7). Trust-Boundary: env-Allowlist
  + `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` gesperrt (erbt aus Core).
- **AC2 — Allowlist-Endpunkt.** `GET /api/red-team/targets` liefert die Schnittmenge VPS-laufend ∩ eigenes Repo.
- **AC3 — Start mit Allowlist-Gate.** `POST /api/red-team` startet den Runner **nur** wenn `projectSlug` in der
  Schnittmenge liegt; sonst **403** (Default deny). Slug→Pfad-Auflösung + Sperre wie `reconcileRouter` (400/409).
- **AC4 — Status.** `GET /api/red-team/:jobId` spiegelt den Job-Status (running|done|failed|auth-expired), inkl. `prHint`
  (Protokoll-/Board-Item-PR-Link), 404 bei unbekannter jobId.
- **AC5 — Router-Auto-Discovery.** `src/routers/redTeam.js` (`create(deps)` + `order`) montiert die Endpunkte; keine
  Änderung an `server.js`-Router-Reihenfolge-Invarianten.
- **AC6 — Composition-Wiring.** `server.js` instanziiert `HeadlessRedTeamRunner` und legt `redTeamRunner` + die für den
  Targets-Endpunkt nötigen Boundaries (`vpsDockerControl`, `vpsRegistry`, `vpsTargets`, `workspaceScanner`) ins `deps`.
- **AC7 — Kachel (Client).** Neue Tile-View `RedTeamView` (Registry-Eintrag `client/src/viewRegistry.js`, Tile im
  Fabrik-Panel-Raster): Ziel-Auswahl **nur** aus `GET /api/red-team/targets` (kein Freitext), `modus`-Auswahl,
  **explizite Feuer-Freigabe-Bestätigung** (Sicherheits-Grenze sichtbar: Trockenlauf-Hinweis + „kein Live-Angriff /
  keine Cloudflare-Umkonfiguration in dieser Iteration"), POST-Start + Status-Polling (Muster `ReconcileTrigger`),
  Ergebnis-Anzeige inkl. Protokoll-Hinweis (`docs/red-team-audit.md`) + PR-Link.
- **AC8 — Leere Allowlist.** Ist die Schnittmenge leer, zeigt die Kachel klar „kein autorisiertes Ziel verfügbar"
  und der Start ist deaktiviert (nichts feuerbar).
- **AC9 — Tests.** Jest-Tests: `test/HeadlessRedTeamRunner.test.js` (Runner: Befehl, args, Timeout-env, Lock),
  `test/redTeamRouter.test.js` (Router: 202/400/403/409/404, Targets-Schnittmenge), `client/src/__tests__/RedTeamView.test.jsx`
  (Allowlist-Only, Bestätigungs-Gate, Poll→done, leere Allowlist).
- **AC10 — Security-Floor.** Keine Secrets/absolute Host-Pfade in Response/Log; `jobId` = Korrelations-ID; argv als Array;
  Allowlist-Gate serverseitig (nicht nur UI).

## Bewusst NICHT

- **Kein realer Live-Angriff / kein Auto-Feuern** — die Kachel triggert die Fabrik-Fähigkeit, die in dieser Iteration
  trocken läuft; die Feuer-Freigabe bleibt menschlich bestätigt.
- **Keine Cloudflare-Umkonfiguration** durch die Kachel — die Koordination (Freischalten/Scharfstellen) ist der
  Ausbauschritt danach (nutzt `CloudflareApi.addRoute/removeRoute`, heute nicht verdrahtet).
- **Kein Freitext-Ziel** — nur die Allowlist-Schnittmenge.
- **Keine persistente Job-Historie** — In-Memory wie Reconcile.
