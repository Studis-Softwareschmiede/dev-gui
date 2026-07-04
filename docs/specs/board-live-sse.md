---
id: board-live-sse
title: "Board-Live-Aktualisierung per Server-Push (SSE) — kein UI-Polling"
status: active
area: board
version: 1
---

# Spec: Board-Live-Aktualisierung per Server-Push (SSE)  (`board-live-sse`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Die Board-Ansicht aktualisiert sich **ohne manuellen Reload** innerhalb von ~1 Minute nach einer Story-Statusänderung — via **Server-Sent-Events** als schmales **Invalidierungs-Signal** (`{slug}`, keine Voll-Payload). Kein Dauer-Polling im UI; im Ruhezustand (keine Änderungen) fließen keine Daten-Events. Quelle der Änderungserkennung ist der **bestehende** `NotificationWatcher`-Snapshot-Diff (60 s-Takt + nach explizitem Board-Rescan), der zusätzlich zum ntfy-Pfad je betroffenem Projekt ein SSE-Event auslöst.

## Verhalten
Drei zusammenwirkende Bausteine:

1. **`BoardEventHub`** (neuer in-process Pub/Sub-Boundary) — hält die offenen SSE-Verbindungen; `subscribe(res)` registriert eine Verbindung, `broadcast({ slug })` schreibt allen offenen Verbindungen ein SSE-Daten-Frame; sendet periodisch einen Heartbeat-Kommentar gegen Proxy-Idle-Timeouts; entfernt geschlossene Verbindungen.
2. **SSE-Endpunkt** `GET /api/board/events` (eigener Router, hinter dem bestehenden `AccessGuard`) — öffnet einen `text/event-stream` und übergibt die Response an den `BoardEventHub`.
3. **Producer-Naht im `NotificationWatcher`** — der bereits vorhandene Snapshot-Diff je `check()` bestimmt zusätzlich die Menge der Projekt-Slugs mit verändertem Story-Status-Abbild und ruft je Projekt genau ein `hub.broadcast({ slug })`. Unabhängig vom ntfy-Gating.
4. **`BoardView`-Abonnent** (Frontend) — öffnet beim Mount **eine** `EventSource` auf `/api/board/events`; bei einem Event für das **aktuell angezeigte** Projekt löst er **genau einen** Re-Fetch über den **bestehenden** Ladepfad aus.

Given–When–Then (Kern):
- **Given** ein Client hat die Board-Ansicht eines Projekts offen, **when** eine Story dieses Projekts den Status wechselt, **then** empfängt der Client innerhalb ~1 Minute ein Invalidierungs-Event und lädt das Projekt genau einmal neu — ohne F5.

## Acceptance-Kriterien

**Backend — `BoardEventHub` + SSE-Endpunkt** (Story 1):
- **AC1** — `GET /api/board/events` antwortet mit Status 200 und den Headern `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` sowie einem Anti-Buffering-Header (`X-Accel-Buffering: no`); die Verbindung wird **offen gehalten** (die Response wird nicht beendet), es wird nichts als Voll-Board-Payload gesendet.
- **AC2** — Der Endpunkt liegt unter `/api/*` und passiert damit den bestehenden `AccessGuard`: ohne gültigen Cloudflare-Access-Nachweis → **403**, keine SSE-Verbindung. Es wird **kein** neuer Auth-Header eingeführt — die `EventSource` nutzt den same-origin Cloudflare-Access-Cookie (analog zu allen bestehenden `fetch`-Aufrufen des Frontends).
- **AC3** — Ein in-process `BoardEventHub` verwaltet die Menge der offenen SSE-Verbindungen: `subscribe(res)` registriert eine Verbindung, `broadcast(payload)` schreibt **jeder** offenen Verbindung ein SSE-Frame. Der Hub hält **keinen** Board-Zustand (nur Verbindungen).
- **AC4** — Broadcast-Format: je Event wird `data: {"slug":"<slug>"}\n\n` geschrieben (Standard-Event-Typ, `EventSource.onmessage`-kompatibel). Payload ist **ausschließlich** `{ slug }` — **keine** Story-/Board-Inhalte.
- **AC5** — Verbindungs-Lifecycle: schließt der Client (Request-`close`), wird die Verbindung aus dem Hub entfernt (kein Leak). Ein `broadcast` auf eine bereits geschlossene/fehlerhafte Verbindung wirft nicht und entfernt diese Verbindung best-effort (kein Crash, keine Störung der übrigen Verbindungen).
- **AC6** — Heartbeat: der Hub sendet periodisch (Intervall **< 100 s**, Richtwert ~25 s — unter dem Cloudflare-Idle-Timeout) an jede offene Verbindung einen SSE-**Kommentar**-Frame (`: ping\n\n`). Der Heartbeat ist ein Kommentar (kein `data:`-Event) und löst clientseitig **keinen** Re-Fetch aus.
- **AC7** — Ruhezustand: ohne Board-Änderung fließen (außer dem Heartbeat aus AC6) **keine** Daten-Events; der Endpunkt eröffnet **kein** zusätzliches serverseitiges Polling über den bestehenden 60 s-`NotificationWatcher`-Takt hinaus.

**Backend — Producer-Naht im `NotificationWatcher`** (Story 2):
- **AC8** — Je `check()` bestimmt der Snapshot-Diff **zusätzlich** zur ntfy-Logik die Menge der Projekt-Slugs, deren Story-Status-Abbild sich gegenüber dem vorherigen Snapshot geändert hat — **mindestens eine** Story mit `prev != curr` **oder** eine hinzugekommene/entfernte Story. Für **jedes** solche Projekt wird **genau ein** `hub.broadcast({ slug })` ausgelöst (kein Event pro einzelner Story).
- **AC9** — Der Baseline-Scan (erster Scan / kein Snapshot auf Disk) löst **kein** SSE-Event aus (still, analog `push-notifications` AC7 — Baseline etabliert ohne Versand).
- **AC10** — Die SSE-Invalidierung ist **unabhängig vom ntfy-Gating**: sie feuert auch bei `enabled=false` und bei Status-Übergängen, die **kein** ntfy-Ereignis sind (z.B. `To Do → In Progress`). ntfy-Versand und SSE-Broadcast sind beide best-effort und voneinander entkoppelt — ein Fehler im einen Pfad crasht weder den `check()` noch den anderen Pfad.
- **AC11** — Der Broadcast läuft auch nach explizitem Rescan (`POST /api/board/projects/rescan` → `notificationWatcher.check()`) über **denselben** Codepfad — kein separater Trigger.
- **AC12** — Der `BoardEventHub` wird in `server.js` konstruiert und dem `NotificationWatcher` **optional injiziert**; fehlt der Hub (Injektion `null`/undefined), degradiert der Watcher **still** (ntfy-Pfad unverändert, kein Crash, kein Broadcast).

**Frontend — `BoardView`-Abonnent** (Story 3):
- **AC13** — `BoardView` öffnet beim Mount **genau eine** `EventSource` auf `/api/board/events` und schließt sie beim Unmount (kein Verbindungs-Leak, keine Doppel-Verbindung bei Re-Render).
- **AC14** — Trifft ein Event ein, dessen `slug` dem **aktuell angezeigten** Projekt entspricht, löst `BoardView` **genau einen** Re-Fetch über den **bestehenden** Ladepfad aus (Cockpit-Modus: Bump des `reloadToken`; Standalone-Modus: Re-Fetch des aktuell selektierten Projekts) — **kein** Voll-Seiten-Reload, **kein** Dauer-Polling.
- **AC15** — Events für **nicht** angezeigte Projekte (anderer `slug`; Standalone-Projektliste ohne Auswahl) lösen **keinen** Re-Fetch aus.
- **AC16** — Der **manuelle Refresh** bleibt unverändert als Fallback bestehen; **Reconnect** nach Verbindungsabbruch übernimmt der `EventSource`-Standard (kein eigener Reconnect-Code). Fällt die `EventSource` dauerhaft aus, bleibt das Board über manuellen Refresh voll nutzbar (still degradierend, **keine** Fehlermauer, **kein** Blockieren des Ladepfads).
- **AC17** — Mehrere kurz aufeinanderfolgende Events für dasselbe angezeigte Projekt führen **nicht** zu überlappenden/inkonsistenten Ladevorgängen (der bestehende `cancelled`-Guard des Ladepfads bleibt wirksam; höchstens ein Re-Fetch-Ergebnis wird übernommen).

## Verträge
- **Endpunkt:** `GET /api/board/events`
  - Auth: `AccessGuard` (Cloudflare-Access-JWT via same-origin Cookie); 403 ohne gültigen Nachweis.
  - Response (Erfolg): `200`, `Content-Type: text/event-stream`, offener Stream.
  - Frames:
    - Daten-Event: `data: {"slug":"<projekt-slug>"}\n\n`
    - Heartbeat: `: ping\n\n` (Kommentar)
- **`BoardEventHub`** (in-process, kein HTTP-Vertrag nach außen):
  - `subscribe(res) → unsubscribe()` — registriert eine SSE-Response-Verbindung.
  - `broadcast({ slug }) → void` — best-effort an alle offenen Verbindungen.
- **`NotificationWatcher`**-Injektion: optionaler Konstruktor-Dependency `boardEventHub` (oder gleichwertige Broadcast-Callback-Naht); wird in `server.js` verdrahtet.
- **Frontend:** `new EventSource('/api/board/events')`; `onmessage` → `JSON.parse(e.data).slug`; Vergleich gegen den angezeigten Projekt-Slug; bei Treffer Re-Fetch über den bestehenden Ladepfad (`reloadToken`-Bump bzw. Re-Select des selektierten Projekts).

## Edge-Cases & Fehlerverhalten
- **Client schließt Tab / navigiert weg:** Request-`close` → Verbindung aus dem Hub entfernt; kein weiterer Schreibversuch.
- **Broadcast auf halb-offene/langsame Verbindung:** Schreibfehler werden gefangen, die betroffene Verbindung best-effort entfernt; übrige Verbindungen unberührt.
- **Board-Scan-Fehler im Watcher:** kein Snapshot-Update, kein Broadcast (bestehendes `NotificationWatcher`-Verhalten unverändert).
- **`EventSource`-Verbindungsabbruch:** automatischer Browser-Reconnect (Standard). Während der Offline-Phase verpasste Invalidierungen werden **nicht** nachgeholt — der manuelle Refresh ist dafür der bewusste Fallback (siehe Nicht-Ziele / Eigen-Entscheidung 3).
- **Kein `AccessGuard`-Bypass:** dev-only `DEV_NO_ACCESS=1` verhält sich wie bei allen anderen `/api/*`-Endpunkten (kein Sonderpfad).

## NFRs
- **Sicherheit (Floor):** Endpunkt hinter `AccessGuard`; kein Auth-Bypass; **keine** Secrets/Board-Inhalte im Stream — ausschließlich `{ slug }`. (Security-relevant → AC2 macht die Authz testbar; Drift-Gate schützt sie.)
- **Kosten/Last:** kein zusätzliches serverseitiges Polling über den bestehenden 60 s-Watcher-Takt hinaus; UI ohne Dauer-Polling; Heartbeat-Intervall < Cloudflare-Idle-Timeout.
- **Robustheit:** Broadcast best-effort; ein toter Client stört weder Server noch andere Clients; Hub-Ausfall/-Fehlen degradiert still (ntfy-Pfad unverändert).

## Nicht-Ziele
- **Keine Voll-Board-Payload über SSE** — nur Invalidierungs-Signal `{ slug }` (Owner-Vorgabe); der eigentliche Board-Zustand kommt weiterhin über den bestehenden `GET /api/board/projects/:slug`-Ladepfad.
- **Kein serverseitiges Event-Replay/Backlog** — verpasste Events während Offline-Phasen werden nicht nachgeliefert (manueller Refresh als Fallback).
- **Kein eigener Reconnect-/Backoff-Code** — der `EventSource`-Standard übernimmt Reconnect.
- **Kein WebSocket** — bewusst SSE (unidirektional Server→Client, EventSource-nativer Reconnect, passt zum reinen Invalidierungs-Push).

### Eigen-Entscheidungen (non-interaktiv getroffen, dokumentiert)
1. **Invalidierung bei *jeder* Story-Status-Änderung** (nicht nur `Done`/`Blocked` wie der ntfy-Pfad) sowie bei hinzugefügten/entfernten Stories — Semantik „Board hat sich geändert". Begründung: Owner-Ziel ist „Aktualisierung innerhalb ~1 min nach *einer Statusänderung*", nicht nur nach Terminal-Übergängen.
2. **Payload = `{ slug }`** (Owner-Vorgabe explizit) — kleinste sinnvolle Invalidierungs-Einheit; das Frontend entscheidet lokal, ob es das aktuell angezeigte Projekt betrifft.
3. **Kein Re-Fetch beim `EventSource`-(Re)connect/`onopen`** — bewusst minimalistisch gehalten (Owner: „Reconnect übernimmt der EventSource-Standard; manueller Refresh bleibt Fallback"). Verpasste Events während kurzer Offline-Phasen werden über den manuellen Refresh aufgefangen; ein automatischer Re-Fetch-on-open wäre ein separates, nicht angefordertes Feature.
4. **Heartbeat als SSE-Kommentar (~25 s)** gegen das Cloudflare-Proxy-Idle-Timeout — Kommentar-Frame, damit er clientseitig keinen Re-Fetch auslöst.
5. **Optionale Hub-Injektion in den `NotificationWatcher`** (null-tolerant) — hält die bestehende ntfy-only-Konstruktion lauffähig und macht die Naht test-/degradations-freundlich.

## Abhängigkeiten
- `[[push-notifications]]` — der `NotificationWatcher`-Snapshot-Diff (Producer-Quelle) stammt aus dieser Capability; diese Spec dockt an den vorhandenen `check()`-Pfad an, ohne dessen ntfy-Verhalten zu ändern.
- Bestehende Bausteine: `AccessGuard` (`/api/*`-Gate), Router-Auto-Loader (`mountRouters`), `GET /api/board/projects/:slug` (Ladepfad), `BoardView.jsx` (`reloadToken`-Mechanik).
</content>
</invoke>
