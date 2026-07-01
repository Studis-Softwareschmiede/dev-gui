---
id: headless-reconcile-runner
title: Headless-Reconcile-Runner — echter `claude -p`-Job statt geratenes PTY-Ende
status: draft
version: 1
---

# Spec: Headless-Reconcile-Runner  (`headless-reconcile-runner`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der Reconcile-Button ([[reconcile-trigger]] S-201, [[reconcile-inline-feedback]] S-205) startet `/agent-flow:reconcile` bisher über den **interaktiven PTY-Pfad** (`CommandService` → `PtyManager` → `PtySessionRegistry`). Dieser Pfad ist für einen **unbeaufsichtigten** Doku-Aufhol-Lauf ungeeignet: das Fertig-Signal wird nur **geraten** (Idle-Timer, [[reconcile-inline-feedback]] Vertrag „CommandService completion = idle 8 s"), ohne Terminal-Zuschauer verwirft der `PtySessionRegistry` die Session, und der Befehl **verpufft**. Zusätzlich scheiterte jeder Lauf, weil die Container-`claude`-Anmeldung fehlte — jetzt behoben ([[claude-code-oauth-token]], Story A: `CLAUDE_CODE_OAUTH_TOKEN`, headless-Probe liefert PONG).

Diese Spec führt einen **echten Headless-Job** ein: ein **neuer, vom interaktiven PTY-Pfad getrennter** Job-Runner startet `/agent-flow:reconcile` als eigenen `claude -p`-**Kindprozess** im aufgelösten Projekt-Verzeichnis. **Prozess-Exit = „fertig"** (deterministisch, kein Rate-Timer). stdout/stderr werden erfasst; ein Timeout schützt vor Runaway; eine Sperre pro Projekt verhindert doppelte Läufe; ein erkannter Auth-Fehler (`401`) wird als klarer Zustand `auth-expired` gemeldet statt still/falsch „fertig". Zwei Endpunkte machen den Job start- und abfragbar. Das Frontend (S-205-`ReconcileTrigger`) wird von der bisherigen `/api/session`-Poll-Quelle auf diesen neuen Endpunkt **umgehängt**.

## Verhalten

### Backend — Runner (Story B-Backend)
1. **Getrennter Runner.** Ein **neuer** Baustein (`src/HeadlessReconcileRunner.js`, o.ä.) startet den Reconcile-Job als **Kindprozess** (`node:child_process` `spawn`, Argumente als **Array**, kein Shell-String) — vollständig **getrennt** vom interaktiven PTY-Pfad (`PtyManager`/`PtySessionRegistry`/`CommandService`). Dieser bleibt für den `/flow`-/Board-Button unverändert; der Runner fasst ihn **nicht** an.
2. **Spawn-Ziel + cwd.** Der Kindprozess ist `claude -p "/agent-flow:reconcile" --dangerously-skip-permissions` (bewusstes `--dangerously-skip-permissions` für den unbeaufsichtigten Job). `cwd` = das über die bestehende Slug-Auflösung ([[flow-trigger]]/`workspacePath.js` `resolveProjectSlug` + WORKSPACE_DIR-Schranke) aufgelöste Projekt-Verzeichnis `/workspace/<slug>`.
3. **Spawn-Env.** Die Child-Env enthält `CLAUDE_CODE_OAUTH_TOKEN`, sofern im Server-Prozess gesetzt ([[claude-code-oauth-token]] AC2) — damit der headless-`claude` sich anmelden kann. `ANTHROPIC_API_KEY` gelangt **nicht** in die Child-Env (Trust-Boundary, [[claude-code-oauth-token]] AC3). Der Token-Wert wird **nie** geloggt.
4. **Prozess-Exit = fertig (deterministisch).** Das `close`/`exit`-Event des Kindprozesses beendet den Job: Exit-Code `0` → Status `done`; kein Idle-/Rate-Timer, kein Raten. stdout und stderr werden während des Laufs **erfasst** (gepuffert/gedraint, keine Pipe-Blockade).
5. **Timeout (Runaway-Schutz).** Überschreitet der Kindprozess ein konfigurierbares Zeitfenster (`RECONCILE_TIMEOUT_MS`, sinnvoller Default, in Tests kurz überschreibbar), wird er terminiert (SIGTERM, ggf. eskalierend) und der Job auf Status `failed` (Timeout-Grund) gesetzt.
6. **Sperre pro Projekt.** Läuft für ein Projekt bereits ein Reconcile-Job, wird ein zweiter Start für **dasselbe** Projekt abgelehnt (kein doppelter Reconcile). Ein Start für ein **anderes** Projekt ist davon nicht blockiert (Lock-Key = aufgelöster Projekt-Pfad, analog [[taktgeber-nachtwaechter]]/`ProjectJobLock`). Die Sperre wird auch bei Crash/Exception des Runners **freigegeben** (try/finally-Disziplin).
7. **401-Erkennung (Stufe 1, Pflicht).** Erkennt der Runner in Exit-Code **oder** in erfasstem stdout/stderr einen Auth-Fehler (`401` bzw. `Invalid authentication credentials`), setzt er den Job auf Status **`auth-expired`** mit klarer Meldung im Sinne „Claude-Anmeldung abgelaufen — Token via `claude setup-token` erneuern" — **nicht** `done`, **nicht** stiller Fehler.

### Backend — Endpunkte (Story B-Backend)
8. **Start-Endpunkt.** `POST /api/reconcile` `{ projectSlug }` startet den Headless-Job und liefert `202 { jobId, status:"running" }`. Bei aktiver Projekt-Sperre → `409`. Bei fehlendem/ungültigem/Traversal-Slug → `400` (Slug-Prüfung vor Pfad-Konkatenation, security/R02/R03).
9. **Status-Endpunkt.** `GET /api/reconcile/:jobId` liefert `{ status: "running"|"done"|"failed"|"auth-expired", result?, error?, prHint? }`. `result`/`prHint` best-effort aus der erfassten Ausgabe (z.B. PR-URL/`#`-Nummer); `error` bei `failed`/`auth-expired` als anzeigbarer, secret-freier Text.

### Frontend — Umhängen des Buttons (Story B-Frontend)
10. **Start über neuen Endpunkt.** Der `ReconcileTrigger` (in `client/src/SpecView.jsx`) POSTet nach Bestätigung ([[reconcile-trigger]] AC2/AC3) auf `POST /api/reconcile` (statt `/api/command`) und erhält `202 { jobId }`. Inline erscheint der Lauf-Zustand **„Reconcile läuft…"** (`role="status"`), der Button ist deaktiviert (disabled + Text-Label, nie Farbe allein).
11. **Fortschritt über neuen Endpunkt (Ablösung der S-205-Poll-Quelle).** Während des Laufs pollt der Trigger `GET /api/reconcile/:jobId` — **nicht mehr** `GET /api/session` als Fertig-Quelle für Reconcile. Status `running` → „Reconcile läuft…" bleibt. Dies **löst bewusst** die Poll-Quelle aus [[reconcile-inline-feedback]] AC2/AC3/AC6 ab (Prozess-Exit statt Session-Busy-Flip).
12. **Fertig bei echtem Prozess-Ende.** Status `done` → inline **„Fertig"** (`role="status"`), Button wieder auslösbar; die Audit-Anzeige (`AuditSpecView`/[[spec-audit-view]]) wird **automatisch genau einmal** neu geladen (wie [[reconcile-inline-feedback]] AC4). PR-Hinweis best-effort, falls im `result`/Audit erkennbar.
13. **Fehlerzustände klar.** Status `failed` → inline Fehler-/Status-Anzeige mit Reset, kein Crash. Status `auth-expired` → **klarer** Hinweis „Claude-Anmeldung abgelaufen — Token via `claude setup-token` erneuern" (Text, nicht nur Farbe) — **kein** falsches „Fertig".

## Acceptance-Kriterien

### Backend-Runner + Endpunkte (Story B-Backend)
- **AC1** — Der neue Runner spawnt `claude` mit Argumenten `['-p','/agent-flow:reconcile','--dangerously-skip-permissions']` als **Array** (kein Shell-String) und mit `cwd` = dem über `resolveProjectSlug` aufgelösten `/workspace/<slug>`. Testbar mit injizierbarem `spawn`-Stub: Kommando, argv und `cwd` werden korrekt übergeben; ungültiger/Traversal-Slug führt **nicht** zum Spawn.
- **AC2** — Ist `CLAUDE_CODE_OAUTH_TOKEN` im Server-Prozess gesetzt, enthält die Spawn-Env des Kindprozesses den Key mit Wert; ist er nicht gesetzt, fehlt der Key (kein leerer Eintrag). `ANTHROPIC_API_KEY` erscheint **nie** in der Child-Env, auch wenn gesetzt (Trust-Boundary, [[claude-code-oauth-token]] AC3). Testbar mit Stub-`process.env` + Spawn-Stub.
- **AC3** — Das `close`/`exit`-Event mit Code `0` setzt den Job **deterministisch** auf `done` (kein Idle-/Rate-Timer); stdout und stderr werden während des Laufs erfasst. Testbar: Spawn-Stub emittiert Output + `close(0)` → Job-Status `done`, erfasste Ausgabe verfügbar.
- **AC4** — Überschreitet der Kindprozess `RECONCILE_TIMEOUT_MS`, wird er terminiert (SIGTERM) und der Job auf `failed` (Timeout-Grund) gesetzt. Testbar mit kurzem Timeout + injizierbarem Timer: Prozess endet nie → nach Fenster `kill` aufgerufen, Status `failed`.
- **AC5** — Ein zweiter Start für ein Projekt mit bereits laufendem Reconcile-Job wird abgelehnt (Sperre greift); ein Start für ein **anderes** Projekt wird **nicht** blockiert. Die Sperre wird nach Job-Ende **und** bei Runner-Exception freigegeben (kein Dauer-Lock). Testbar mit zwei Slugs + erzwungener Exception.
- **AC6** — Enthält Exit-Code **oder** erfasstes stdout/stderr `401` bzw. `Invalid authentication credentials`, ist der Job-Status **`auth-expired`** (nicht `done`, nicht `failed`) mit klarer Erneuerungs-Meldung (`claude setup-token`). Testbar: Spawn-Stub emittiert `401`-Zeile → Status `auth-expired`, Meldung enthält den Erneuerungs-Hinweis; der Token-Wert taucht in keiner Log-/Fehlerausgabe auf.
- **AC7** — Der Runner ist **getrennt** vom interaktiven PTY-Pfad: er importiert/mutiert **weder** `PtyManager`, `PtySessionRegistry` **noch** den `CommandService`-Schreibpfad; der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt unverändert (Regression-Schutz). Testbar: bestehende `CommandService`/`PtySessionRegistry`-Tests bleiben grün; der Runner-Test benötigt keinen PTY-Mock.
- **AC8** — `POST /api/reconcile` `{ projectSlug }` startet den Job → `202 { jobId, status:"running" }`; bei aktiver Projekt-Sperre → `409`; bei fehlendem/ungültigem/Traversal-Slug → `400`. Testbar mit injizierbarem Runner/Slug-Resolver (supertest-Muster wie `commandRouter`).
- **AC9** — `GET /api/reconcile/:jobId` liefert `{ status, result?, error?, prHint? }` mit `status ∈ {running,done,failed,auth-expired}`; unbekannte `jobId` → `404`. `error`/`result` sind secret-frei (kein Token, kein absoluter Host-Pfad im Klartext). Testbar mit injiziertem Job-Status.

### Frontend-Umhängen (Story B-Frontend)
- **AC10** — Nach Bestätigung POSTet der `ReconcileTrigger` **genau einmal** `POST /api/reconcile` (statt `/api/command`) und zeigt bei `202` inline **„Reconcile läuft…"** (`role="status"`), Button deaktiviert (disabled + Text-Label). `onNavigate` wird **nicht** aufgerufen. Testbar mit mockbarer `fetchFn`.
- **AC11** — Im Lauf-Zustand pollt der Trigger `GET /api/reconcile/:jobId` (**nicht** `/api/session` als Fertig-Quelle); solange `status:"running"`, bleibt „Reconcile läuft…" und der Button deaktiviert. **Bewusste Ablösung** der Poll-Quelle aus [[reconcile-inline-feedback]] AC2/AC3/AC6. Testbar: `fetchFn`-Sequenz `running` → „läuft" bleibt, kein `/api/session`-Aufruf zur Fertig-Erkennung.
- **AC12** — Status `done` → inline **„Fertig"** (`role="status"`), Button wieder auslösbar; die Audit-Anzeige (`AuditSpecView`/[[spec-audit-view]]) wird **automatisch genau einmal** neu geladen (kein Doppel-Reload). Testbar: `fetchFn`-Sequenz `running` → `done` → „Fertig" + genau ein Audit-Reload.
- **AC13** — Status `failed` → inline Fehler-/Status-Anzeige mit Reset (`role="alert"` o.ä.), **kein** `onNavigate`, kein Crash. Testbar mit mockbarer `fetchFn`.
- **AC14** — Status `auth-expired` → **klare** Meldung „Claude-Anmeldung abgelaufen — Token via `claude setup-token` erneuern" (Text, `role="status"`/`alert`, nicht nur Farbe); **kein** falsches „Fertig". Testbar mit mockbarer `fetchFn` (`auth-expired`-Antwort).
- **AC15** — Der Trigger ist **entkoppelt testbar** über injizierbaren `fetchFn` (Default `window.fetch`); kein Test hängt an einem realen Reconcile-Lauf oder realer agent-flow-Antwort. Ein erkennbarer PR-Bezug im `result` wird als dezenter Link (`rel="noopener noreferrer"`) gezeigt, sonst kein PR-Element (graceful absence). Tests liegen in `client/src/__tests__/` und folgen dem `SpecView`-Testmuster.

## Verträge
- **Neuer Baustein:** `src/HeadlessReconcileRunner.js` (o.ä.) — Kindprozess-Runner, injizierbarer `spawnFn` (Default `node:child_process` `spawn`) für Tests. Hält Job-Registry (jobId → {status, result, error, prHint}) im Prozess.
- **Neuer Endpunkt-Router:** `src/routers/reconcile.js` (Factory `create(deps)` + `order`-Hint, geladen via `routerLoader`), gemountet hinter `AccessGuard`.
  - `POST /api/reconcile` `{ projectSlug:string }` → `202 { jobId:string, status:"running" }` | `400 { error }` (Slug fehlt/ungültig/Traversal) | `409 { error }` (Projekt-Sperre).
  - `GET /api/reconcile/:jobId` → `200 { status:"running"|"done"|"failed"|"auth-expired", result?, error?, prHint? }` | `404 { error }` (unbekannte jobId).
- **Spawn-Vertrag:** `claude` mit argv `['-p','/agent-flow:reconcile','--dangerously-skip-permissions']`; `cwd` = `resolveProjectSlug(projectSlug)` (WORKSPACE_DIR-Schranke, security/R02/R03); Child-Env `{ …minimale Allowlist…, CLAUDE_CODE_OAUTH_TOKEN? }`, **ohne** `ANTHROPIC_API_KEY`.
- **Env/Config:** `RECONCILE_TIMEOUT_MS` (Runaway-Timeout, Default sinnvoll, in Tests kurz). `CLAUDE_CODE_OAUTH_TOKEN` (Herkunft [[claude-code-oauth-token]]).
- **Frontend-Ort:** `client/src/SpecView.jsx` — `ReconcileTrigger` hängt von `/api/command`+`/api/session`-Fertig-Poll ([[reconcile-inline-feedback]]) auf `POST /api/reconcile` + `GET /api/reconcile/:jobId` um; injizierbarer `fetchFn`. Der `AuditSpecView`-Reload-Mechanismus aus [[reconcile-inline-feedback]] AC4 wird wiederverwendet.
- **Unverändert:** `/api/command`, `/api/session`, Sanitisierung/Allowlist ([[flow-trigger]] AC2), `docs/raw`-API + `MarkdownLite` ([[spec-audit-view]]) — keine Änderung.
- **Cross-Repo (SR3):** Die Reconcile-**Logik** lebt in **agent-flow** (`reconcile-subsystem.md`); dev-gui startet nur den `claude -p`-Prozess und liest dessen Exit/Ausgabe. UI + Runner sind **entkoppelt** testbar (mockbarer `spawnFn`/`fetchFn`); kein Test hängt an einem realen agent-flow-Lauf.

## Edge-Cases & Fehlerverhalten
- **Nicht-null Exit ohne 401:** Exit-Code ≠ 0 und keine 401-Signatur → `failed` mit generischem, secret-freiem Grund (kein stderr-Leak von Pfaden/Env).
- **401 + Exit 0 (Auth-Fehler im Output trotz sauberem Exit):** 401-Signatur hat Vorrang → `auth-expired` (nicht `done`).
- **`claude` nicht im PATH (`ENOENT`):** `failed` mit generischer Meldung „claude nicht verfügbar"; kein Crash, Sperre freigegeben.
- **Timeout exakt bei Exit (Race):** kein Doppel-Statuswechsel; erster terminaler Zustand gewinnt, `kill` auf bereits beendeten Prozess ist no-op.
- **Doppelter POST für dasselbe Projekt:** zweiter Start → `409` (AC5/AC8), kein zweiter Kindprozess.
- **Server-Neustart mit laufendem Job:** In-Memory-Job-Registry geht verloren → `GET :jobId` liefert `404`; Frontend degradiert neutral (kein Endlos-Spinner, manueller „Audit-Spec anzeigen" bleibt bedienbar, wie [[reconcile-inline-feedback]] AC8).
- **`GET :jobId`-Fehler während Poll:** einzelner Fehler → Zustand bleibt (kein Flackern); anhaltender Fehler/`404` → neutrale Degradierung mit manuellem Refresh.
- **Kein `projectSlug`:** `POST /api/reconcile` → `400` (im Gegensatz zum globalen `/api/command`-Fallback; der Headless-Runner ist stets projektgebunden).

## NFRs
- **Sicherheit:** argv als Array, kein Shell-Interpolation (security/R03); `projectSlug` nur als Session-/Lock-Key + validierter `cwd`, nie an eine Shell (security/R02); Slug-Traversal-Prüfung vor Pfad-Konkatenation (R02/R03). `CLAUDE_CODE_OAUTH_TOKEN` in der Child-Env durchgereicht, `ANTHROPIC_API_KEY` **blockiert** (Trust-Boundary). **Kein** Token-Wert und **kein** absoluter Host-Pfad in Logs/Fehler-Responses. `--dangerously-skip-permissions` ausschliesslich im getrennten Headless-Runner (nicht im interaktiven Pfad). Alle Endpunkte hinter `AccessGuard` (security/R04).
- **Robustheit:** Prozess-Exit = deterministisches Fertig (kein Rate-Timer); Runaway-Timeout; Sperre mit try/finally-Freigabe (kein Dauer-Lock bei Crash).
- **A11y (WCAG 2.1 AA):** Lauf-/Fertig-/Fehler-/auth-expired-Zustände als Text (`role="status"`/`alert`, `aria-live="polite"`), nicht nur Farbe; Button-Sperre via disabled + Text-Label; sichtbarer Fokusring; Touch-Targets ≥ 44 px; PR-Link mit zugänglichem Namen + `rel="noopener noreferrer"`.
- **Entkopplung (SR3):** Runner über `spawnFn`, Frontend über `fetchFn` mockbar — kein Test benötigt einen echten `claude`-Lauf.

## Nicht-Ziele
- Die Reconcile-**Logik** selbst (Stufe-1/Stufe-2-Abgleich, Diff-Freigabe, Schreiben des Logbuchs `docs/spec-audit.md`) — liegt vollständig in **agent-flow** (`reconcile-subsystem.md`).
- Umbau/Ersatz des interaktiven PTY-Pfads (`PtyManager`/`PtySessionRegistry`/`CommandService`) — bleibt unverändert für Flow-/Board-Button ([[flow-trigger]]/[[autonome-board-abarbeitung]]).
- Live-Streaming der Reconcile-Ausgabe in den Spezifikation-Reiter (nur Lauf-/Fertig-/Fehler-Zustand + Audit-Ergebnis).
- Persistente/serverseitige Job-Historie über den Prozess-Lebenszyklus hinaus oder mehrere gleichzeitige Läufe **desselben** Projekts (Sperre begrenzt auf max. 1 pro Projekt).
- Automatischer Token-Refresh oder Auth-Health-Probe (→ [[claude-auth-health]], Story C).

## Abhängigkeiten
- [[claude-code-oauth-token]] (Story A, **Done**) — `CLAUDE_CODE_OAUTH_TOKEN` in der Prozess-Umgebung; der Runner reicht ihn in die Spawn-Env durch (AC2).
- [[reconcile-trigger]] (S-201) — Button, Bestätigungsdialog, Busy-Guard (AC1–AC4 gelten weiter); der 202-Pfad wird auf `/api/reconcile` umgehängt.
- [[reconcile-inline-feedback]] (S-205) — **wird abgelöst:** die Fertig-Poll-Quelle (`/api/session`-Busy-Flip, AC2/AC3/AC6) wird durch den `GET /api/reconcile/:jobId`-Poll **ersetzt** (AC11, bewusste Ablösung). Der inline Lauf-/Fertig-Zustand + Audit-Auto-Refresh (AC1/AC4) bleiben als Muster erhalten.
- [[spec-audit-view]] (S-203) — `AuditSpecView` wird nach `done` automatisch neu geladen (AC12), Anzeige-/404-Verhalten wie dort.
- [[taktgeber-nachtwaechter]] / `ProjectJobLock` — Muster für die Sperre pro Projekt (Lock-Key = Projekt-Pfad, try/finally-Freigabe).
- [[flow-trigger]] / `workspacePath.js` — `resolveProjectSlug` + WORKSPACE_DIR-Schranke für `cwd`-Auflösung (unverändert genutzt).
- **agent-flow** `reconcile-subsystem.md` (Cross-Repo, SR3) — liefert die Reconcile-Logik hinter `/agent-flow:reconcile`.
