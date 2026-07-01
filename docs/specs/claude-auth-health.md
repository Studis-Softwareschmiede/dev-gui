---
id: claude-auth-health
title: Claude-Auth-Health — Ablauf der Container-Anmeldung erkennen, bevor ein Job startet
status: draft
version: 1
---

# Spec: Claude-Auth-Health  (`claude-auth-health`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Die Container-`claude`-Anmeldung ([[claude-code-oauth-token]], `CLAUDE_CODE_OAUTH_TOKEN`) kann **ablaufen** oder ungültig werden. Heute merkt das niemand, bis ein Lauf (Reconcile via [[headless-reconcile-runner]], `/flow`, Nachtwächter) mit `401 Invalid authentication credentials` scheitert — der Runner erkennt das dann zwar (Stufe 1, [[headless-reconcile-runner]] AC6), aber **erst nachdem** jemand einen Job gestartet hat.

Diese Spec ergänzt **Stufe 2**: ein **leichtgewichtiger Auth-Probe** prüft **beim Boot** und danach **periodisch** (Intervall, z.B. täglich), ob sich `claude` headless anmelden kann. Bei `401` zeigt das Panel eine **Statusanzeige/Badge „Claude-Auth: abgelaufen"** (analog zur bestehenden GitHub-/CI-Statusanzeige) samt klarer Erneuerungs-Anleitung (`claude setup-token`). So wird der Ablauf **erkannt, bevor** jemand etwas startet. Die Probe-Logik ist mockbar; der Token-Wert erscheint **nie** im Log.

## Verhalten
1. **Boot-Probe.** Beim Server-Boot läuft **einmal** ein winziger headless-`claude`-Auth-Check (z.B. ein minimaler `claude -p`-Ping, dessen einziges Interesse „anmelden ja/nein" ist). Das Ergebnis wird als Auth-Health-Zustand `ok` **oder** `expired` festgehalten (plus Zeitpunkt der letzten Prüfung).
2. **Periodische Probe.** Danach wiederholt sich die Probe in einem **konfigurierbaren Intervall** (Default z.B. täglich). Die Terminierung folgt dem bestehenden Scheduler-Muster ([[taktgeber-nachtwaechter]]/`NightWatchScheduler`): eine `setTimeout`-Kette (kein `setInterval`-Drift), mit **injizierbaren** Timer-Funktionen für Tests.
3. **401 → abgelaufen.** Erkennt die Probe in Exit/Output einen Auth-Fehler (`401` bzw. `Invalid authentication credentials`), ist der Zustand `expired`. Ein erfolgreicher Check (anmeldung möglich) setzt `ok`. Ein nicht-auth-bedingter Fehler (z.B. `claude` nicht im PATH, Timeout) setzt einen neutralen `unknown`-Zustand (kein Fehlalarm „abgelaufen").
4. **Zustand abfragbar (Backend).** Ein Status-Endpunkt liefert den Auth-Health-Zustand (`ok`|`expired`|`unknown` + `lastCheckedAt`) — **ohne** jeglichen Token-Wert. (Angliederung an die bestehende Status-/Health-Route, analog GitHub-/CI-Status.)
5. **Badge (Frontend).** Das Panel zeigt bei `expired` eine **Badge/Statusanzeige „Claude-Auth: abgelaufen"** (Text, nicht nur Farbe), analog zur bestehenden GitHub-/CI-Statusanzeige, mit klarer Erneuerungs-Anleitung (`claude setup-token`, Claude-Abo nötig). Bei `ok` neutral/unauffällig (kein Alarm). Bei `unknown` ein dezenter neutraler Hinweis (kein roter Alarm).
6. **Kein Token-Leak.** Weder Probe, Endpunkt noch Badge geben den Token-Wert aus; die Probe-Logik ist über einen injizierbaren Runner mockbar.

## Acceptance-Kriterien
- **AC1** — Beim Boot läuft die Auth-Probe **einmal** über einen **injizierbaren** headless-Runner; das Ergebnis wird als Auth-Health-Zustand (`ok`|`expired`|`unknown`) + `lastCheckedAt` festgehalten. Testbar mit Stub-Runner: `ok`-Antwort → Zustand `ok`; die Probe wird genau einmal beim Boot aufgerufen.
- **AC2** — Nach dem Boot wiederholt sich die Probe in einem **konfigurierbaren Intervall** über eine `setTimeout`-Kette mit **injizierbaren** Timer-Funktionen (`setTimeoutFn`/`clearTimeoutFn`, Muster [[taktgeber-nachtwaechter]]). Testbar: Vorspulen der injizierten Timer löst genau eine weitere Probe pro Intervall aus (kein Drift, kein Doppel-Feuer).
- **AC3** — Erkennt die Probe `401` bzw. `Invalid authentication credentials` (Exit/Output), ist der Zustand `expired`; ein erfolgreicher Check → `ok`; ein nicht-auth-Fehler (z.B. `ENOENT`/Timeout) → `unknown` (kein Fehlalarm „expired"). Testbar mit Stub-Runner je Fall.
- **AC4** — Ein Status-Endpunkt (Backend) liefert `{ claudeAuth: "ok"|"expired"|"unknown", lastCheckedAt }` (bzw. als Feld der bestehenden Status-/Health-Antwort) — **ohne** Token-Wert. Testbar (supertest o.ä.): Response enthält den Zustand + `lastCheckedAt`, **kein** Token/Secret.
- **AC5** — Das Panel zeigt bei `expired` eine **Badge/Statusanzeige „Claude-Auth: abgelaufen"** (Text/Label, nicht nur Farbe) mit Erneuerungs-Anleitung (`claude setup-token`), analog zur bestehenden GitHub-/CI-Statusanzeige; bei `ok` neutral (kein Alarm), bei `unknown` dezent-neutral. Testbar mit mockbarer `fetchFn`/gestubbtem Zustand je Fall (ok/expired/unknown).
- **AC6** — **Kein Token-Wert** erscheint in Log, Endpunkt-Response oder Badge; die Probe-Logik ist über den injizierbaren Runner **mockbar** (kein Test hängt an einem realen `claude`-Aufruf). Testbar: durchsuchte Log-/Response-Ausgabe der Probe enthält keinen Token; Badge-Zustand ok/expired ist ohne echten `claude` reproduzierbar.

## Verträge
- **Neuer Baustein:** `src/ClaudeAuthHealthService.js` (o.ä.) — hält den Auth-Health-Zustand (`ok`|`expired`|`unknown` + `lastCheckedAt`), injizierbarer `probeFn` (Default: headless-`claude`-Ping via `node:child_process` `spawn`) und injizierbare Timer (`setTimeoutFn`/`clearTimeoutFn`), Muster [[taktgeber-nachtwaechter]]/`NightWatchScheduler`.
- **Probe:** headless `claude -p <minimaler-ping>` (argv als Array, kein Shell-String); Auswertung: `401`/`Invalid authentication credentials` in Exit/Output → `expired`; sauberer Erfolg → `ok`; sonstiger Fehler → `unknown`. `CLAUDE_CODE_OAUTH_TOKEN` in der Child-Env (wie [[headless-reconcile-runner]] AC2), `ANTHROPIC_API_KEY` blockiert.
- **Status-Endpunkt:** Feld `claudeAuth: "ok"|"expired"|"unknown"` + `lastCheckedAt` in der bestehenden Status-/Health-Response (z.B. `GET /api/status`) **oder** ein dedizierter `GET /api/claude-auth`; **kein** Token-Wert. Hinter `AccessGuard`.
- **Frontend-Badge:** Panel-Komponente (analog zur bestehenden GitHub-/CI-Statusanzeige), gespeist über injizierbaren `fetchFn`; drei Zustände (ok/expired/unknown) mit Text-Label.
- **Config/Env:** `CLAUDE_AUTH_PROBE_INTERVAL_MS` (o.ä.; Default z.B. 24 h, in Tests kurz überschreibbar). `CLAUDE_CODE_OAUTH_TOKEN` (Herkunft [[claude-code-oauth-token]]).
- **Testbarkeit/Entkopplung (SR3):** Backend über `probeFn` + injizierbare Timer, Frontend über `fetchFn` mockbar — kein Test benötigt einen echten `claude`-Aufruf.

## Edge-Cases & Fehlerverhalten
- **`claude` nicht im PATH (`ENOENT`) / Timeout:** Zustand `unknown` (kein Fehlalarm „expired"), Badge neutral; kein Crash, Scheduler läuft weiter.
- **Probe-Fehler beim Boot:** Boot wird **nicht** blockiert (best-effort, wie Boot-Diagnose [[claude-code-oauth-token]] AC4); Zustand bleibt `unknown` bis zur nächsten erfolgreichen Probe.
- **Overlap:** Läuft eine Probe noch, wird keine zweite parallel gestartet (die `setTimeout`-Kette plant erst nach Abschluss neu — kein Doppel-Feuer, [[taktgeber-nachtwaechter]]-Muster).
- **`/api/status`-Fehler im Frontend:** Badge degradiert neutral (kein roter Alarm bei reinem Netzwerkfehler), Rest des Panels bleibt bedienbar.
- **Zustandswechsel expired → ok nach Token-Erneuerung:** die nächste Probe (oder ein manuell angestossener Boot/Neustart) setzt `ok`; kein Sticky-`expired`.

## NFRs
- **Sicherheit:** argv als Array, kein Shell-Interpolation (security/R03); **kein** Token-Wert in Log/Response/Badge; `CLAUDE_CODE_OAUTH_TOKEN` durchgereicht, `ANTHROPIC_API_KEY` blockiert (Trust-Boundary, [[claude-code-oauth-token]] AC3); Endpunkt hinter `AccessGuard` (security/R04).
- **Robustheit:** best-effort, nicht boot-blockierend; `setTimeout`-Kette ohne Drift; kein Overlap; neutraler `unknown`-Zustand statt Fehlalarm.
- **A11y (WCAG 2.1 AA):** Badge-Zustand als Text/Label (nicht nur Farbe), `role="status"`/`aria-live`, sichtbarer Fokus; Erneuerungs-Anleitung als lesbarer Hinweis/Link.
- **Performance:** Probe nur beim Boot + im Intervall (kein Dauer-Polling); leichtgewichtiger Ping (kein voller Agent-Lauf).

## Nicht-Ziele
- **Kein** automatischer Token-Refresh/-Erneuerung — die Anleitung verweist auf `claude setup-token` (manuell); der Automatismus ist ausserhalb dieser Spec.
- **Kein** Ersatz der Stufe-1-Erkennung im Reconcile-Runner ([[headless-reconcile-runner]] AC6) — beide bestehen nebeneinander (Stufe 1 beim Lauf, Stufe 2 vorbeugend).
- **Kein** Ablegen/Ausgeben eines echten Token-Werts.
- **Keine** Historie/Trend der Auth-Health über den aktuellen Zustand + `lastCheckedAt` hinaus.

## Abhängigkeiten
- [[claude-code-oauth-token]] (Story A, **Done**) — `CLAUDE_CODE_OAUTH_TOKEN` in der Prozess-Umgebung; die Probe reicht ihn in die Child-Env durch.
- [[headless-reconcile-runner]] (Story B) — Stufe-1-401-Erkennung beim Lauf (AC6); diese Spec ergänzt die vorbeugende Stufe 2. **Keine** harte Reihenfolge-Abhängigkeit (Story C ist unabhängig baubar).
- [[taktgeber-nachtwaechter]] / `NightWatchScheduler` — Muster für die periodische, drift-freie Terminierung mit injizierbaren Timern.
- Bestehende GitHub-/CI-Statusanzeige (`GET /api/status`/Panel-Badge) — Muster/Ort für die Auth-Badge.
