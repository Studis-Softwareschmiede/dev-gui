---
id: reconcile-inline-feedback
title: Reconcile inline — auf dem Spezifikation-Reiter bleiben, Lauf halten, Fortschritt + Audit-Refresh
status: draft
version: 1
---

# Spec: Reconcile inline  (`reconcile-inline-feedback`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der bestehende Button „Konzept/Spec nachziehen" ([[reconcile-trigger]], S-201) startet den Fabrik-Befehl `/agent-flow:reconcile`, **navigiert danach aber zwangsweise in den Terminal-/Fabrik-Bereich** (`onNavigate('factory')`, [[reconcile-trigger]] AC5). Im Live-Test landet der User dadurch auf der **Projektauswahl** und sieht nie, ob der Lauf passiert; zusätzlich hält die Hintergrund-Session ohne Terminal-Zuschauer nicht (der `PtySessionRegistry` verwirft Sessions nach Idle), sodass der Lauf faktisch nicht stattfindet.

Diese Spec macht den Reconcile-Auslöser **selbst-genügsam auf dem Spezifikation-Reiter**: kein Wegspringen, ein **inline** Fortschritts-/Fertig-Zustand, ein **am Leben gehaltener** Hintergrund-Lauf für **dieses** Projekt und eine **automatische Aktualisierung der Audit-Anzeige** ([[spec-audit-view]], S-203) nach Abschluss. Sie **überschreibt** damit [[reconcile-trigger]] **AC5** (Navigate-nach-Erfolg) und ergänzt Backend-Verhalten, damit ein laufender Job die Session hält und über `GET /api/session` als `busy` sichtbar ist.

## Verhalten
1. **Kein Wegspringen (ersetzt [[reconcile-trigger]] AC5).** Nach erfolgreichem Auslösen (`POST /api/command` → `202`) bleibt die Ansicht auf dem Reiter „Spezifikation"; `onNavigate('factory')` wird **nicht mehr** aufgerufen. Stattdessen erscheint **inline** im `ReconcileTrigger`-Bereich ein Lauf-Zustand **„Reconcile läuft…"** (`role="status"`).
2. **Fortschritt pollen.** Während der Lauf-Zustand aktiv ist, pollt der `ReconcileTrigger` `GET /api/session` (bestehendes Polling-Muster, wie Flow-Button). Solange die Session `state:"busy"` meldet (Job läuft), bleibt „Reconcile läuft…" stehen und der Button ist deaktiviert (disabled-Attribut **+** Text-Label, nie Farbe allein).
3. **Fertig-Meldung.** Wechselt die Session von `busy` → nicht-`busy` (`ready`/Job fertig), während der Lauf-Zustand aktiv war, wechselt die Anzeige inline auf einen **„Fertig"**-Zustand (`role="status"`) und der Button ist wieder auslösbar.
4. **Audit-Refresh nach Abschluss.** Beim Übergang auf „Fertig" wird die Audit-Anzeige ([[spec-audit-view]] / `AuditSpecView`, lädt `docs/spec-audit.md`) **automatisch neu geladen**, sodass das Ergebnis des Laufs **ohne manuellen Klick** auf demselben Reiter sichtbar wird. Fehlt die Datei weiterhin (`404`), greift der freundliche Hinweis aus [[spec-audit-view]] AC3 (kein Fehler-Look).
5. **PR-Hinweis (best-effort).** Ist im geladenen Audit-Inhalt ein Pull-Request-Bezug erkennbar (z.B. eine PR-URL/`#`-Nummer im Logbuch), zeigt die Anzeige einen dezenten **Link/Hinweis** darauf. Ist keiner erkennbar, wird **kein** PR-Element gezeigt (graceful absence, kein Platzhalter, kein Crash).
6. **Lauf hält die Session (Backend).** Ein laufender `/agent-flow:reconcile`-Job **hält** die zugehörige Projekt-Session am Leben: der `PtySessionRegistry` verwirft eine Session **nicht**, solange für sie ein Job in Flight ist — auch **ohne** WebSocket-Zuschauer. Erst nach Abschluss greift die reguläre Idle-Regel wieder.
7. **Busy nach außen sichtbar (Backend).** Solange der Job läuft, meldet `GET /api/session` für das Projekt `state:"busy"`; nach Abschluss `ready` (bzw. nicht-`busy`). Der laufende Command-Zustand (`CommandService`/JobLock) wird dafür über `/api/session` **sichtbar gemacht** — heute reflektiert die Route nur den PTY-Lebenszyklus, nicht den laufenden Job.
8. **Robuste Degradierung.** Kann der Poll den Abschluss innerhalb eines beschränkten Sicherheitsfensters nicht bestätigen (Session flippt nie zurück, `GET /api/session` schlägt wiederholt fehl), degradiert die UI **neutral**: kein Endlos-Spinner, kein Crash; ein Text-Hinweis + manuelle „Audit-Spec anzeigen"-/Aktualisieren-Möglichkeit bleibt bedienbar.
9. **Fehlerpfade unverändert.** `409`/`500`/Netzwerkfehler beim Auslösen erzeugen weiterhin eine **inline** Fehler-/Status-Anzeige mit Reset ([[reconcile-trigger]] AC6/AC7) — **ohne** `onNavigate`, ohne Crash.

## Acceptance-Kriterien
- **AC1** — Nach `POST /api/command` → `202` wird `onNavigate` **nicht** aufgerufen (überschreibt [[reconcile-trigger]] AC5); stattdessen ist inline ein Lauf-Zustand **„Reconcile läuft…"** (`role="status"`) sichtbar und der Trigger-Button ist deaktiviert (disabled **+** Text-Label). Testbar mit mockbarer `fetchFn` (202-Antwort) — kein `onNavigate`-Aufruf.
- **AC2** — Im Lauf-Zustand pollt der `ReconcileTrigger` `GET /api/session`; solange die Antwort `state:"busy"` liefert, bleibt „Reconcile läuft…" sichtbar und der Button deaktiviert. Testbar: `fetchFn` gibt nacheinander `busy` → „läuft" bleibt.
- **AC3** — Meldet `GET /api/session` nach vorherigem `busy` erstmals **nicht**-`busy` (`ready`), während der Lauf-Zustand aktiv war, wechselt die inline Anzeige auf einen **„Fertig"**-Zustand (`role="status"`) und der Button ist wieder auslösbar. Testbar: `fetchFn`-Sequenz `busy` → `ready` → „Fertig" erscheint.
- **AC4** — Beim Übergang auf „Fertig" (AC3) wird die Audit-Anzeige (`docs/spec-audit.md` via bestehende `docs/raw`-API, [[spec-audit-view]]) **automatisch genau einmal** (re)geladen, ohne manuellen Klick; der gerenderte Inhalt (bzw. bei `404` der freundliche Hinweis [[spec-audit-view]] AC3) ist danach sichtbar. Testbar über mockbaren `fetchFn`: nach `ready` erfolgt genau ein `GET …/docs/raw?path=docs/spec-audit.md`.
- **AC5** — Enthält der geladene Audit-Inhalt einen erkennbaren PR-Bezug (PR-URL oder `#<nummer>`), wird ein dezenter **Link/Hinweis** darauf angezeigt; enthält er keinen, wird **kein** PR-Element gerendert (kein Platzhalter, kein Crash). Best-effort (SHOULD) — beide Fälle testbar mit mockbarem Inhalt.
- **AC6** — Bei laufendem `/agent-flow:reconcile`-Job meldet `GET /api/session` für das betroffene Projekt `state:"busy"`; nach Abschluss `ready`/nicht-`busy`. D.h. der laufende Command-/JobLock-Zustand ist über `/api/session` sichtbar (Backend-Test: während Job in Flight → `busy`, nach Freigabe → nicht-`busy`).
- **AC7** — Solange ein Reconcile-Job in Flight ist, wird die zugehörige Projekt-Session vom `PtySessionRegistry` **nicht** idle-destroyed — auch ohne WebSocket-Zuschauer; erst nach Job-Abschluss greift die reguläre Idle-Regel wieder. Backend-Test: Idle-Fenster verstreicht bei aktivem Job → Session lebt; nach Abschluss → Idle-Destroy wieder möglich.
- **AC8** — Kann der Abschluss innerhalb eines beschränkten Sicherheitsfensters nicht bestätigt werden (Session flippt nie zurück **oder** `GET /api/session` schlägt wiederholt fehl), zeigt die UI einen neutralen Text-Hinweis (kein Endlos-Spinner, kein Crash) und lässt „Audit-Spec anzeigen"/Aktualisieren manuell zu. Testbar: `fetchFn` liefert dauerhaft `busy`/Fehler → nach Fenster neutraler Zustand.
- **AC9** — `409`/`500`/Netzwerkfehler beim Auslösen erzeugen weiterhin die inline Fehler-/Status-Anzeige mit Reset **ohne** `onNavigate`-Aufruf und ohne Crash (Regression-Schutz zu [[reconcile-trigger]] AC6/AC7). Testbar mit mockbarer `fetchFn`.

## Verträge
- **Frontend-Ort:** `client/src/SpecView.jsx` — `ReconcileTrigger` (Lauf-/Fertig-Zustand statt Navigate) + Kopplung zu `AuditSpecView` (programmatischer Reload). Der `onNavigate`-Aufruf im 202-Pfad entfällt; die Prop darf entfallen oder ungenutzt bleiben (keine andere Nutzung brechen).
- `POST /api/command` `{command:"/agent-flow:reconcile", projectPath?}` → `202 {commandId,status}` | `400` | `409` | `500`. **Unverändert** — Endpunkt, Allowlist ([[reconcile-trigger]] Verträge) und Sanitisierung ([[flow-trigger]] AC2) bleiben wie sie sind.
- `GET /api/session` → `{state:"ready"|"busy"|"starting"|"stopped"|"failed", …}`. **Vertragsänderung (Backend):** `state` muss `busy` melden, **solange** für die betroffene Session ein Command-Job in Flight ist (JobLock gehalten / `CommandService.getStatus().status === 'running'`), und danach nicht-`busy`. Bestehende Felder (`restarts`, `startedAt`) bleiben. Kein neuer Endpunkt zwingend nötig — Erweiterung des bestehenden `state`-Werts (`src/routers/session.js`, gespeist aus `CommandService`/`PtyManager`).
- **Session-Lebensdauer:** `src/PtySessionRegistry.js` — die Idle-Destroy-Regel ist so zu ergänzen, dass eine Session mit **aktivem Job** nicht verworfen wird (Idle-Timer wird gehalten/zurückgesetzt, solange der Job läuft; die konkrete Mechanik entscheidet der `coder` gegen den bestehenden Code — JobLock-Kopplung oder Keep-Alive). Kein Bruch der bestehenden Idle-Regel für Sessions **ohne** Job.
- **Audit-Reload:** wiederverwendet die bestehende `docs/raw`-API und den `MarkdownLite`-Renderer ([[spec-audit-view]] Verträge) — **kein** neuer Endpunkt, **kein** `dangerouslySetInnerHTML`. Der Reload wird programmatisch ausgelöst (z.B. Ref/Callback/Reload-Signal an `AuditSpecView`).
- **Testbarkeit/Entkopplung (SR3):** Frontend über mockbaren `fetchFn` testbar (kein Test hängt an einem realen Reconcile-Lauf oder realer agent-flow-Antwort); Backend-ACs (AC6/AC7) über die bestehenden Command-/Registry-Testmuster (`CommandService.test.js`, `PtySessionRegistry.test.js`) mit injizierbarem Lock/kurzem Idle-Fenster.

## Edge-Cases & Fehlerverhalten
- **Race busy→ready sofort:** liefert der erste Poll bereits nicht-`busy` (sehr kurzer Lauf), wird direkt „Fertig" gezeigt + Audit einmal geladen (kein Hängenbleiben in „läuft").
- **`/api/session`-Fehler während Poll:** einzelner Fehler → aktueller Zustand bleibt (kein Flackern); anhaltender Fehler → AC8 (neutrale Degradierung).
- **Kein `projectSlug`:** Trigger läuft gegen globale Session (Backwards-Compat, [[reconcile-trigger]] Edge-Cases); Audit-Reload nur bei vorhandenem Slug (sonst neutraler Hinweis, [[spec-audit-view]] Edge-Cases).
- **No-Op-Reconcile:** liefert der Lauf keine Doku-Änderung, muss die Audit-Anzeige dennoch etwas zeigen — das setzt voraus, dass das Logbuch `docs/spec-audit.md` **auch bei No-Op** einen Eintrag erhält (Cross-Repo, siehe Abhängigkeiten: agent-flow Variante D / SR3). Fehlt die Datei, greift der `404`-Hinweis (AC4/[[spec-audit-view]] AC3) — kein Fehler-Look.
- **Doppel-Reload:** der automatische Audit-Reload (AC4) darf nur **einmal** pro Abschluss feuern (kein Loop durch wiederholte `ready`-Polls); ein bereits „Fertig"-Zustand triggert kein erneutes Laden.
- **Idle-Race Backend:** Job endet exakt im Idle-Fenster → keine Doppel-Destroy/Use-after-free; Session wird erst nach dokumentiertem Job-Ende idle-fähig.

## NFRs
- **A11y (WCAG 2.1 AA):** Lauf-/Fertig-Zustände als Text (`role="status"`, `aria-live="polite"`), nicht nur Farbe; Button-Sperre via disabled-Attribut **und** Text-Label; sichtbarer Fokusring; Touch-Targets ≥ 44 px. PR-Hinweis als echter Link mit zugänglichem Namen.
- **Sicherheit (Floor):** Kein neuer Backend-Endpunkt für den Trigger; `/api/command` durchläuft die unveränderte Sanitisierung + Allowlist ([[flow-trigger]] AC2). Die `/api/session`-Erweiterung gibt **nur** einen Zustandswert preis (keine Secrets, keine Pfade, keine Command-Inhalte). Audit-Render ausschließlich über `MarkdownLite`, **kein** `dangerouslySetInnerHTML`; fester Pfad `docs/spec-audit.md` (kein Traversal). PR-Link nur aus dem gerenderten Audit-Inhalt (kein nutzergesteuerter offener Redirect: `target=_blank` mit `rel="noopener noreferrer"`).
- **Performance:** Poll nur **während** eines aktiven Lauf-Zustands (kein Dauer-Polling im Leerlauf über das bestehende Busy-Poll hinaus); Audit-Reload genau einmal pro Abschluss (on-demand, kein Auto-Poll des Audit-Inhalts).
- **Robustheit:** beschränktes Sicherheitsfenster gegen Endlos-Spinner (AC8); Backend-Idle-Halten darf keine Session **dauerhaft** am Leben halten (nur für die Job-Dauer).

## Nicht-Ziele
- Die Reconcile-**Logik** selbst (Stufe-1/Stufe-2-Abgleich, Diff-Freigabe, **Schreiben** des Logbuchs `docs/spec-audit.md`, No-Op-Eintrag) — liegt vollständig in **agent-flow** (`reconcile-subsystem.md`, Variante D). dev-gui zeigt nur an.
- Live-Streaming der Reconcile-Ausgabe in den Spezifikation-Reiter (Terminal-Detailausgabe bleibt dem Fabrik-Bereich vorbehalten) — hier nur Lauf-/Fertig-Zustand + Audit-Ergebnis.
- Änderungen am `/api/command`-Endpunkt, an der Sanitisierung, am `docs/raw`-Endpunkt oder am `MarkdownLite`-Renderer.
- Persistente/serverseitige Job-Historie oder mehrere gleichzeitige Reconcile-Läufe (der JobLock bleibt max. 1 laufender Command).

## Abhängigkeiten
- [[reconcile-trigger]] (S-201) — **wird fortgeschrieben:** diese Spec **überschreibt dessen AC5** (Navigate-nach-Erfolg) durch Bleiben-auf-dem-Reiter + Lauf-/Fertig-Zustand (AC1–AC3). AC1–AC4/AC6/AC7 von [[reconcile-trigger]] (Button, Bestätigungsdialog, POST, Busy-Guard, Fehlerpfade) bleiben gültig.
- [[spec-audit-view]] (S-203) — die `AuditSpecView` wird nach Abschluss **automatisch** neu geladen (AC4); Anzeige-/404-Verhalten wie dort spezifiziert.
- [[projekt-spezifikation-anzeige]] (`SpecView`, `docs/raw`, `MarkdownLite`) und [[flow-trigger]] (Session-Poll-/Busy-Muster, `/api/command`, `/api/session`).
- **agent-flow — Variante D (Cross-Repo, SR3/depends, anderes Repo):** Damit die Audit-Anzeige **auch bei einem No-Op-Reconcile** ein Ergebnis zeigt, muss der `/agent-flow:reconcile`-Skill in **agent-flow** sicherstellen, dass das Logbuch `docs/spec-audit.md` **auch ohne Doku-Änderung** einen Eintrag erhält (No-Op-Vermerk). Die dev-gui-UI ist davon **entkoppelt** baubar/testbar (mockbarer `fetch`; der `404`-Pfad deckt „noch kein/kein Eintrag" ab) — **kein** dev-gui-Test hängt an dieser agent-flow-Änderung.
