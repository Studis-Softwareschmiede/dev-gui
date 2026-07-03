/**
 * ProjectDrain — zentrale Drain-Engine für EIN Projekt
 * (docs/specs/taktgeber-nachtwaechter.md AC1, AC2, AC3, AC4, AC5, AC18).
 *
 * Stößt `/agent-flow:flow` wiederholt für genau EIN Projekt an, bis das Board
 * keine **Drain-Ziel-Story** mehr hat und auch keine `To Do`-Story durch
 * Fertigstellen eines Vorgängers ready werden kann (AC1/AC2). Implementiert die
 * Eskalation gegen Endlosschleifen (AC4/AC5) und auditiert Drain-Start +
 * Eskalation (AC18, "jeder /flow-Anstoß" wird bereits durch `CommandService`
 * selbst auditiert — siehe dort — und daher hier NICHT doppelt erfasst).
 *
 * Drain-Ziel — verbindliche Definition (Spec §Verhalten, hier NICHT neu
 * definiert, nur konsumiert):
 *   (a) `To Do`-Stories mit `ready==true` (gemäß
 *       `BoardAggregator.computeStoryReadyStatus`, bereits im Index als
 *       `story.ready` verfügbar).
 *   (b) Verwaiste `In Progress`-Stories — `updated_at` länger als
 *       `staleInProgressHours` zurück (kein `updated_at`/unparsbar → defensiv
 *       NICHT als Ziel behandelt, AC3 "Nicht-Drain-Ziele ... nie als Ziel
 *       gewählt").
 *   `Done`, `Blocked`, `Idee` und nicht-ready `To Do` sind NIE Drain-Ziele
 *   (AC3) und werden außer durch die Eskalation (AC4) nie verändert.
 *
 * Abbruch-/Konvergenz-Regel (AC2, zustandsbasiert):
 *   Der Drain stoppt, sobald keine Drain-Ziel-Story mehr existiert UND keine
 *   `To Do`-Story durch Fertigstellen eines Vorgängers ready werden KANN. Eine
 *   `To Do`-Story "kann ready werden", wenn ihr `ready_reason` AUSSCHLIESSLICH
 *   an einem noch nicht fertigen `depends`-Eintrag hängt — und dieser
 *   Vorgänger TRANSITIV (über die gesamte `depends`-Kette, nicht nur den
 *   direkten Vorgänger) noch "lebendig" ist (siehe `computeAliveStoryIds`).
 *
 *   KORREKTUR (S-192 Review-Iteration 2, live verifiziert): eine Prüfung, die
 *   nur den DIREKTEN Status des unmittelbaren Vorgängers anschaut (`To Do`/
 *   `In Progress` = "lebendig"), konvergiert NICHT — eine mehrstufige Kette
 *   toter Knoten (`Blocked` ← `To Do` ← `To Do`, der mittlere Knoten bleibt
 *   selbst `To Do` obwohl er nie fertig werden kann) oder ein Zyklus
 *   (`depends` zeigt im Kreis aufeinander, z.B. S-1 ⇄ S-2) lässt
 *   `couldBecomeReady` für immer `true` bleiben, obwohl KEINE dieser
 *   Stories je Done werden kann. Live reproduziert: `drainProject()` hing in
 *   diesem Fall >2 Minuten bei 100% CPU (Microtask-Loop ohne echten I/O-
 *   Yield, kein Timeout griff), musste per SIGKILL beendet werden — das
 *   Projekt-Lock (nur in `finally` freigegeben) blieb dauerhaft gehalten.
 *
 *   `computeAliveStoryIds` bestimmt deshalb per FIXPOINT-ITERATION über ALLE
 *   Stories, welche Knoten beweisbar "lebendig" sind (könnten über genug
 *   Drain-Runden Done werden): ein Knoten ist sofort lebendig, wenn er
 *   `Done` ist oder keine unerfüllten `depends` hat; ein `To Do`/
 *   `In Progress`-Knoten wird lebendig, sobald ALLE seine unerfüllten
 *   `depends` selbst (bereits bewiesen) lebendig sind. `Blocked`/`Idee`/
 *   fehlende Knoten werden NIE lebendig. Die Iteration fügt nur hinzu, was
 *   beweisbar ist — Knoten, die nur in einem Zyklus aufeinander verweisen
 *   (A↔B), werden NIE lebendig (keiner kann je beweisbar werden, ohne dass
 *   der jeweils andere es zuerst ist) — Zyklen werden so korrekt als
 *   nicht-erfüllbare Sackgasse behandelt, ohne sie explizit als Graph-Zyklus
 *   erkennen zu müssen. Konvergenz wird dadurch wieder GENUIN zustandsbasiert
 *   erreicht (nicht "ausschließlich durch die Eskalation", wie eine frühere
 *   Fassung dieser Doku fälschlich behauptete — die Eskalation (AC4) bleibt
 *   zusätzlich nötig, weil sie tatsächliche Drain-Ziel-Stories voranbringt,
 *   die zwar lebendig sind, aber wiederholt keinen Fortschritt machen).
 *
 * Sicherheitsgürtel (Defense-in-Depth, AC2-Nicht-Ziel "keine
 * fortschrittsbasierte Abbruch-Heuristik" bleibt für die NORMALE,
 * primäre Stop-Entscheidung unverändert in Kraft — dies ist ein davon
 * unabhängiger Backstop, kein Ersatz):
 *   `#runLoop` zählt zusätzlich, unabhängig von `couldBecomeReady`,
 *   aufeinanderfolgende Runden OHNE JEGLICHE Snapshot-Änderung (kein
 *   Status-/Ready-Wechsel irgendeiner Story im gesamten Projekt). Erreicht
 *   dieser Zähler `safetyMaxNoProgressRounds` (Default 50 — weit über jedem
 *   plausiblen `escalationAttempts`-Wert, der echte Eskalationen periodisch
 *   per Snapshot-Änderung zurücksetzt), bricht der Drain HART ab
 *   (`reason: 'safety-stop-no-progress'`); das Lock wird wie immer in
 *   `finally` freigegeben. Bei korrekter Logik (transitive Sackgassen-
 *   Erkennung oben) sollte dieser Pfad nie auslösen — er ist reiner
 *   Backstop gegen unvorhergesehene künftige Logikfehler (z.B. fehlender
 *   `boardWriter`, sodass Eskalationen nie greifen).
 *
 * Event-Loop-Yield (Defense-in-Depth gegen 100%-CPU-Spin): jede Runde der
 * Hauptschleife awaitet zusätzlich einen echten Makrotask-Tick
 * (`setImmediate`, unabhängig vom injizierbaren `sleepFn`/`pollIntervalMs`
 * der Completion-Polling-Logik) — verhindert, dass eine rein Promise-/
 * Microtask-getriebene Schleife (z.B. wenn `tryRun`/`getStatus` synchron
 * sofort resolvieren) den Node-Event-Loop verhungern lässt, selbst wenn ein
 * künftiger Logikfehler wieder einen Tight-Loop erzeugen sollte (genau das
 * o.g. >2-Minuten-100%-CPU-Verhalten).
 *
 * Eskalation (AC4/AC5):
 *   Ein /flow-Lauf gilt als "fortschrittslos", wenn sich zwischen dem
 *   Board-Snapshot (status+ready je Story, projektweit, Muster:
 *   `NotificationWatcher.detectTransitions`) vor und nach dem Lauf NICHTS
 *   geändert hat. `escalationAttempts` aufeinanderfolgende fortschrittslose
 *   Läufe → die am längsten unbewegte AKTUELLE Drain-Ziel-Story wird über
 *   `BoardWriter.setBlocked` auf `Blocked` gesetzt (Zähler wird danach
 *   zurückgesetzt — garantiert Konvergenz, da jede Eskalation die Menge der
 *   möglichen künftigen Ziele dauerhaft um genau eine Story verkleinert).
 *
 * Randfall "couldBecomeReady, aber aktuell keine Targets" (z.B. eine To-Do-
 * Story wartet auf einen NOCH NICHT verwaisten — frischen — In-Progress-
 * Vorgänger): hier wird `/agent-flow:flow` weiter aufgerufen (Definition,
 * Punkt 1) statt zu stoppen. Das ist kein Tight-Spin in Produktion — jeder
 * Lauf nimmt real Zeit (CommandService-Idle-Completion, default 8s) und
 * `now()` schreitet real voran, sodass der Vorgänger irgendwann entweder
 * fertig wird (Snapshot ändert sich → Fortschritt) oder selbst verwaist und
 * zum echten Target wird (löst sich über die normale Drain-Schleife auf,
 * kein Sonderfall nötig — siehe test/ProjectDrain.test.js "waits for the
 * fresh predecessor to go stale").
 *
 * Concurrency (AC6/AC7, Wiederverwendung S-190):
 *   `drainProject()` prüft `isProjectBusy()` UND erwirbt zusätzlich das
 *   eigene `ProjectJobLock` für `projectPath` — beide Prüfungen laufen ohne
 *   `await` dazwischen (Node Single-Thread-Event-Loop ⇒ atomar, keine
 *   TOCTOU-Lücke). Das Lock wird IMMER in `finally` freigegeben (Edge-Case
 *   "Projekt-Lock bei Crash").
 *
 * Nacht-Budget-Schutz (S-273, docs/specs/night-budget-guard.md AC4-AC8):
 *   `drainProject()` behandelt zwei Budget-Signale zusätzlich zur normalen
 *   Ziel-Auswahl/Konvergenz/Eskalation, OHNE deren Logik zu verändern (AC8,
 *   Default-Regress bit-identisch ohne injizierten `budgetGuard` und ohne
 *   `budget-limited`-Status):
 *   - REAKTIV (AC4): liefert `flowRunner.awaitCompletion()` den Status
 *     `'budget-limited'` (S-270, mit `resetAt`), gilt der Lauf NICHT als
 *     fortschrittslos — der Drain merkt sich `resetAt` (ruft `budgetGuard
 *     .noteReset(resetAt)`, falls injiziert), erfasst eine Budget-Pause
 *     (`reason:'reactive-limit'`) und wartet bis `resetAt +
 *     budgetResumeBufferMs` (Default `BUDGET_RESUME_BUFFER_MS`, ~5 min),
 *     sofern das nicht hinter `opts.windowEndMs` liegt — dieser reaktive
 *     Pfad braucht KEINEN injizierten `budgetGuard` (immer aktiv, AC11).
 *   - PROAKTIV (AC5): ist ein `budgetGuard` injiziert, fragt der Drain
 *     dessen `checkProactive({nowMs})` VOR jeder Flow-Runde (Story-Grenze);
 *     bei Pause startet keine Runde (kein `flowRuns`-Increment), eine
 *     Budget-Pause (`reason:'proactive-threshold'`) wird erfasst und über
 *     `budgetGuard.awaitResume({resumeAt, windowEndMs, nowMs})` gewartet
 *     bzw. sanft geendet.
 *   - SANFTES ENDE (AC6): liegt der Fortsetzungs-Zeitpunkt hinter
 *     `opts.windowEndMs` (reaktiv) bzw. liefert der Guard `resumed:false`
 *     (proaktiv, `reason:'budget-window-end'|'budget-stop'`), stoppt der
 *     Drain sauber (kein Kill laufender Läufe, Lock-Freigabe wie immer via
 *     `finally`) — `drainProject()` liefert dann zusätzlich zu den
 *     bisherigen `reason`-Werten (`'no-drain-target'|'already-busy'|
 *     'command-channel-busy'|'safety-stop-no-progress'|'scan-failed'`) auch
 *     `'budget-window-end'|'budget-stop'`.
 *   - ESKALATIONS-SCHUTZ (AC7, kritisch): `budget-limited`-Ergebnisse,
 *     Budget-Pausen und Budget-Stops erhöhen NIE `consecutiveNoProgress`/
 *     `totalNoProgressRounds` und lösen NIE `boardWriter.setBlocked` aus.
 *   - Rückgabe additiv um `budgetPauses: [{from,to,reason}]` (`to=null` bei
 *     sanftem Ende), auf JEDEM Rückgabepfad vorhanden (leer `[]`, wenn keine
 *     Budget-Pause auftrat — kein Regress an bestehenden Feldern, AC8).
 *   Der konkrete `BudgetGuard` (kapselt [[token-usage-meter]] + Settings +
 *   Reset-Merken) sowie die Scheduler-/`server.js`-Verdrahtung (`windowEndMs`
 *   via `computeWindowEndMs`) sind NICHT Teil dieser Story (S-274) — hier
 *   wird nur das injizierbare `budgetGuard`-Interface konsumiert.
 *
 * Nicht in dieser Story (bewusst NICHT gebaut, siehe Spec "Nicht-Ziele" +
 * Story-Scope-Hinweis):
 *   - Nachtfenster-Scheduler / `maxParallel` (S-195 NightWatchScheduler)
 *   - "Board abarbeiten"-Knopf-Umbau (S-196) / Settings-Store (S-194) / UI (S-197)
 *
 * Lock-Contention gegen den GLOBALEN CommandService/JobLock (S-195 Review-
 * Iteration 2, live verifiziert — critical, siehe `.claude/lessons/coder.md`
 * 2026-07-01): `NightWatchScheduler` startet bis zu `maxParallel`
 * `drainProject()`-Läufe für VERSCHIEDENE Projekte, aber `CommandService`
 * serialisiert weiterhin über einen einzigen PROZESSWEITEN `JobLock`
 * (`src/CommandService.js`, "Step 3: Concurrency lock") — der projektweise
 * `ProjectJobLock` (AC6/AC7) gilt nur für den DRAIN selbst, nicht für den
 * darunterliegenden PTY-Schreibpfad. Gewinnt Projekt A den globalen Lock,
 * bekommt jeder GLEICHZEITIGE `tryRun()`-Aufruf für Projekt B
 * `{ok:false, reason:'locked'}` zurück — OBWOHL Projekt B's Drain-Ziel-Story
 * völlig gesund und unverändert ist. Eine frühere Fassung dieser Klasse
 * wertete das fälschlich als "Lauf ohne Fortschritt" und eskalierte B's
 * legitime Story nach `escalationAttempts` auf `Blocked` — reine
 * Lock-Contention, keine echte Blockade (Board-Datenkorruption im
 * Standard-Nachtbetrieb, Default `maxParallel=3`).
 *
 *   FIX: `#runLoop` unterscheidet jetzt explizit "der /flow-Anstoß konnte
 *   gerade nicht starten, weil der globale Command-Kanal von einem ANDEREN
 *   Projekt belegt ist" (`tryResult.reason === 'locked'|'busy'`, KEIN Lauf
 *   fand statt) von "ein /flow lief wirklich, brachte aber keinen
 *   Fortschritt" (normale AC4/AC5-Eskalationslogik, unverändert). Im
 *   Contention-Fall bricht der Drain für DIESES Projekt SOFORT sauber ab
 *   (`reason: 'command-channel-busy'`, kein Spin, keine Eskalation, keine
 *   Zustandsänderung an irgendeiner Story) — das eigene `ProjectJobLock` wird
 *   wie immer in `finally` freigegeben, das Projekt bleibt Kandidat für den
 *   nächsten Scheduler-Tick (`NightWatchScheduler` filtert `#activeDrains`
 *   nur auf tatsächlich noch laufende Promises, nicht auf diesen Ausgang).
 *
 *   Bewusst NICHT Teil dieses Fixes (separate Folge-Story S-204, `depends:
 *   [S-195]`): der zentrale `CommandService`/`JobLock`-Umbau auf einen
 *   projektweisen PTY-Lock, der ECHTE parallele /flow-Läufe ermöglichen
 *   würde. Dieser Fix macht den Drain nur ROBUST gegen die bestehende
 *   Serialisierung — er hebt sie nicht auf. Effektiv bleibt bei
 *   `maxParallel>1` (Default 3) genau EIN /flow-Lauf gleichzeitig aktiv;
 *   die übrigen Projekte "warten" (kein Spin, kein Fehl-Blocked) bis zum
 *   nächsten Tick, an dem der globale Kanal wieder frei sein kann.
 *
 * FlowRunner-Injection (S-212, docs/specs/headless-parallel-drain.md
 * AC4/AC5/AC6): der Ausführungs-Schritt — "einen /flow-Lauf starten + auf
 * sein ECHTES Ende warten" — läuft NICHT mehr hart über `CommandService`,
 * sondern über ein injizierbares `FlowRunner`-Interface (`src/FlowRunner.js`,
 * `startRun()`/`awaitCompletion()`). Ohne explizit übergebenen `flowRunner`
 * baut der Konstruktor per Default einen `InteractiveFlowRunner` um das
 * übergebene `commandService` — DAS bedeutet: der manuelle „Board
 * abarbeiten"-Knopf (S-196) und das Terminal bleiben bit-identisch zum
 * bisherigen Verhalten (AC6), inklusive des `command-channel-busy`-Mappings
 * für `reason:'locked'|'busy'` oben. `commandService` wird zusätzlich WEITER
 * separat für `isProjectBusy()` (AC7-Busy-Erkennung) gehalten — das ist ein
 * eigenständiges Signal, unabhängig vom Ausführungs-Schritt, und bleibt
 * unverändert. Ein injizierter `HeadlessFlowRunnerAdapter` (S-213
 * Scheduler-Verdrahtung, hier NICHT gebaut) ersetzt nur den Ausführungs-
 * Schritt — die gesamte übrige Logik oben (Ziel-Auswahl, Konvergenz,
 * Eskalation, Snapshot-Diff, Sicherheitsgürtel) arbeitet identisch mit
 * beiden Adaptern, da sie ausschließlich auf dem Board-Snapshot (nicht auf
 * dem FlowRunner-Ergebnis) operiert.
 *
 * @module ProjectDrain
 */

import { projectJobLock, isProjectBusy } from './ProjectJobLock.js';
import { InteractiveFlowRunner } from './FlowRunner.js';

/** Einziger /flow-Befehl, den der Drain anstößt (Nicht-Ziel: keine Modell-/Cost-Mode-Logik). */
export const FLOW_COMMAND = '/agent-flow:flow';

/** Default `staleInProgressHours` (Settings-Schema-Default, S-194 übernimmt dies später aus dem Store). */
export const DEFAULT_STALE_IN_PROGRESS_HOURS = 4;

/** Default `escalationAttempts` (Settings-Schema-Default, s.o.). */
export const DEFAULT_ESCALATION_ATTEMPTS = 3;

/** Default Poll-Intervall (ms) beim Warten auf das Ende eines /flow-Laufs (CommandService idle-completion). */
export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Default Sicherheitsgürtel (S-192 Review-Iteration 2, Defense-in-Depth):
 * harte Obergrenze aufeinanderfolgender Runden OHNE JEGLICHE Snapshot-
 * Änderung, unabhängig von `couldBecomeReady`/Eskalation. Weit über jedem
 * plausiblen `escalationAttempts`-Wert (Default 3, gültig ≥1) — echte
 * Eskalationen setzen den Zähler über eine beobachtbare Status-Änderung
 * zurück, lange bevor dieser Wert erreicht wird. Greift NUR bei
 * unvorhergesehenen Logikfehlern (z.B. fehlender `boardWriter`).
 */
export const DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS = 50;

/**
 * Default Fortsetzungs-Puffer (ms) NACH einem reaktiv erkannten
 * `resetAt`-Zeitpunkt (docs/specs/night-budget-guard.md A3, AC4) — bewusst
 * großzügiger als der 1-Min-Puffer des interaktiven `TokenLimitWatcher`-
 * Pfads (headless-Prozesse starten träger, Reset-Zeit ist gerundet).
 * Injizierbar über `budgetResumeBufferMs` (NFR Testbarkeit, kein echtes
 * Warten in Tests nötig).
 */
export const BUDGET_RESUME_BUFFER_MS = 5 * 60 * 1000;

// ── Pure Helpers (kein IO — direkt unit-testbar) ──────────────────────────────

/**
 * Flacht alle Stories eines Projekt-Index-Eintrags (inkl. der `_orphaned`
 * Pseudo-Feature) zu einer flachen Liste ab.
 *
 * @param {import('./BoardAggregator.js').ProjectEntry|null} project
 * @returns {import('./BoardAggregator.js').StoryEntry[]}
 */
export function flattenProjectStories(project) {
  if (!project || !Array.isArray(project.features)) return [];
  const out = [];
  for (const feature of project.features) {
    for (const story of feature.stories ?? []) out.push(story);
  }
  return out;
}

/**
 * Drain-Ziel (b): verwaiste `In Progress`-Story — `updated_at` liegt länger
 * als `staleInProgressHours` zurück. Fehlendes/unparsbares `updated_at` →
 * defensiv NICHT stale (AC3: nie versehentlich ein Nicht-Ziel anfassen).
 *
 * @param {import('./BoardAggregator.js').StoryEntry} story
 * @param {number} nowMs
 * @param {number} staleInProgressHours
 * @returns {boolean}
 */
export function isStaleInProgress(story, nowMs, staleInProgressHours) {
  if (!story || story.status !== 'In Progress') return false;
  if (!story.updated_at || typeof story.updated_at !== 'string') return false;
  const t = Date.parse(story.updated_at);
  if (Number.isNaN(t)) return false;
  const staleMs = staleInProgressHours * 60 * 60 * 1000;
  return nowMs - t > staleMs;
}

/**
 * Bestimmt per FIXPOINT-ITERATION über ALLE Stories, welche Knoten beweisbar
 * "lebendig" sind — d.h. theoretisch über genug Drain-Runden `Done` werden
 * KÖNNTEN (S-192 Review-Iteration 2: Wurzel-Fix für die Konvergenz-Garantie,
 * ersetzt eine frühere Single-Hop-Prüfung, die nur den DIREKTEN Status des
 * unmittelbaren Vorgängers ansah und für mehrstufige tote Ketten sowie
 * Zyklen NICHT konvergierte — siehe Modul-Doku).
 *
 * Regeln:
 *   - `Done` → sofort lebendig (Basisfall).
 *   - `Blocked`/`Idee`/sonstiger Status → NIE lebendig (dauerhafte Sackgasse).
 *   - `To Do`/`In Progress` ohne unerfüllte `depends` (alle Done oder leer)
 *     → sofort lebendig.
 *   - `To Do`/`In Progress` MIT unerfüllten `depends` → lebendig, sobald
 *     ALLE unerfüllten `depends` selbst (bereits bewiesen) lebendig sind.
 *
 * Die Iteration fügt monoton nur hinzu, was beweisbar ist, bis ein Fixpunkt
 * erreicht ist (keine Änderung mehr in einer Runde). Knoten, die nur in
 * einem Zyklus aufeinander verweisen (z.B. S-1 ⇄ S-2, beide `To Do`), werden
 * dadurch korrekt NIE lebendig — keiner von ihnen kann beweisbar werden,
 * ohne dass der jeweils andere es zuerst ist, und das passiert nie (ein
 * Zyklus kann nie zu "alle depends Done" führen). Ein fehlender `depends`-
 * Verweis (Story existiert nicht) macht den abhängigen Knoten ebenfalls nie
 * lebendig (er wird in keiner Runde zu `alive` hinzugefügt, da `alive.has`
 * für eine nicht-existente ID nie `true` wird).
 *
 * @param {import('./BoardAggregator.js').StoryEntry[]} stories
 * @param {Map<string, import('./BoardAggregator.js').StoryEntry>} storiesById
 * @returns {Set<string>} IDs aller (transitiv) lebendigen Stories
 */
export function computeAliveStoryIds(stories, storiesById) {
  const alive = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of stories) {
      if (!story || alive.has(story.id)) continue;
      if (story.status === 'Done') {
        alive.add(story.id);
        changed = true;
        continue;
      }
      if (story.status !== 'To Do' && story.status !== 'In Progress') continue; // Blocked/Idee/sonstiges: nie lebendig
      const depends = Array.isArray(story.depends) ? story.depends.filter(Boolean) : [];
      const unmet = depends.filter((depId) => {
        const dep = storiesById.get(String(depId));
        return !dep || dep.status !== 'Done';
      });
      if (unmet.length === 0 || unmet.every((depId) => alive.has(String(depId)))) {
        alive.add(story.id);
        changed = true;
      }
    }
  }
  return alive;
}

/**
 * Prüft, ob eine nicht-ready `To Do`-Story ready werden KÖNNTE, sobald ihre
 * `depends`-Vorgänger fertiggestellt sind (AC2). Gilt NUR, wenn:
 *   (1) Story ist `To Do`, `ready==false`, kein `blocked_reason`.
 *   (2) `ready_reason` hängt AUSSCHLIESSLICH an einem noch nicht fertigen
 *       Vorgänger (`computeStoryReadyStatus` meldet diesen Grund erst, NACHDEM
 *       alle anderen Regeln — Spec/Implements — bereits erfüllt sind).
 *   (3) JEDER unerfüllte `depends`-Eintrag referenziert eine EXISTIERENDE
 *       Story, die TRANSITIV "lebendig" ist (`computeAliveStoryIds`, S-192
 *       Iteration 2 — nicht mehr nur der direkte Status). Ein dauerhaft
 *       feststeckender Vorgänger (auch mehrere Hops entfernt, auch ein
 *       Zyklus) macht die Story NICHT "könnte ready werden" (Konvergenz-
 *       Garantie, siehe Modul-Doku).
 *
 * @param {import('./BoardAggregator.js').StoryEntry} story
 * @param {Map<string, import('./BoardAggregator.js').StoryEntry>} storiesById
 * @returns {boolean}
 */
export function couldBecomeReadyViaDepends(story, storiesById) {
  if (!story || story.status !== 'To Do' || story.ready === true) return false;
  if (story.blocked_reason) return false;
  if (typeof story.ready_reason !== 'string' || !story.ready_reason.startsWith('abhängige Story nicht Done:')) {
    return false;
  }
  const depends = Array.isArray(story.depends) ? story.depends.filter(Boolean) : [];
  if (depends.length === 0) return false;

  const alive = computeAliveStoryIds([...storiesById.values()], storiesById);

  for (const depId of depends) {
    const dep = storiesById.get(String(depId));
    if (!dep) return false; // Sackgasse: Vorgänger existiert nicht
    if (dep.status === 'Done') continue;
    if (!alive.has(String(depId))) return false; // Sackgasse: transitiv nie lebendig (inkl. Zyklen)
  }
  return true;
}

/**
 * Berechnet Drain-Targets, Konvergenz-Flag und den projektweiten
 * Status+Ready-Snapshot (für die Fortschritts-Erkennung, AC5) für einen
 * einzelnen Board-Scan.
 *
 * @param {import('./BoardAggregator.js').ProjectEntry|null} project
 * @param {number} nowMs
 * @param {number} staleInProgressHours
 * @returns {{
 *   targets: import('./BoardAggregator.js').StoryEntry[],
 *   couldBecomeReady: boolean,
 *   snapshot: Map<string, { status: string|null, ready: boolean }>
 * }}
 */
export function computeDrainState(project, nowMs, staleInProgressHours) {
  const stories = flattenProjectStories(project);
  const storiesById = new Map(stories.map((s) => [s.id, s]));
  const snapshot = new Map();
  const targets = [];
  let couldBecomeReady = false;

  for (const story of stories) {
    snapshot.set(story.id, { status: story.status ?? null, ready: story.ready === true });

    if (story.status === 'To Do' && story.ready === true) {
      targets.push(story);
    } else if (isStaleInProgress(story, nowMs, staleInProgressHours)) {
      targets.push(story);
    }
  }

  for (const story of stories) {
    if (couldBecomeReadyViaDepends(story, storiesById)) {
      couldBecomeReady = true;
      break;
    }
  }

  return { targets, couldBecomeReady, snapshot };
}

/**
 * Vergleicht zwei Snapshots (Muster: `NotificationWatcher.detectTransitions`)
 * auf Gleichheit — true, wenn KEINE Story neu erschienen/verschwunden ist und
 * sich kein `status`/`ready` geändert hat (AC5 "Fortschritt").
 *
 * @param {Map<string, { status: string|null, ready: boolean }>} a
 * @param {Map<string, { status: string|null, ready: boolean }>} b
 * @returns {boolean}
 */
export function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, val] of a) {
    const other = b.get(id);
    if (!other || other.status !== val.status || other.ready !== val.ready) return false;
  }
  return true;
}

/**
 * Wählt unter den aktuellen Drain-Targets die am längsten unbewegte Story
 * (kleinste `lastChangeRound`, AC4). Bei Gleichstand: deterministisch
 * kleinste `id` (Testbarkeit/Reproduzierbarkeit).
 *
 * @param {import('./BoardAggregator.js').StoryEntry[]} targets
 * @param {Map<string, number>} lastChangeRound  storyId → Runde der letzten Zustandsänderung
 * @returns {import('./BoardAggregator.js').StoryEntry|null}
 */
export function pickLongestUnmovedTarget(targets, lastChangeRound) {
  let best = null;
  let bestRound = Infinity;
  for (const t of targets) {
    const r = lastChangeRound.has(t.id) ? lastChangeRound.get(t.id) : 0;
    if (best === null || r < bestRound || (r === bestRound && t.id < best.id)) {
      best = t;
      bestRound = r;
    }
  }
  return best;
}

/**
 * Leitet aus dem Anfangs-Status-Snapshot (Status je Story-ID VOR der ersten
 * `/flow`-Runde) und dem End-Snapshot-Projekt (letzter Board-Scan) die während
 * des Drains erledigten bzw. blockierten Stories ab (docs/specs/
 * drain-completion-report.md AC1/AC2):
 *   - `completed` — Stories, die von einem Nicht-`Done`-Status (`To Do`/
 *     `In Progress`) nach `Done` übergingen.
 *   - `blocked`   — Stories, die nach `Blocked` übergingen (Obermenge der
 *     Taktgeber-`escalated`-Liste: Eskalationen durch den Taktgeber PLUS
 *     durch `/flow` selbst gesetzte `Blocked`).
 *
 * Je Eintrag `{ id, title }`; `title` stammt aus dem End-Snapshot-Board-
 * Eintrag (`BoardAggregator`-Story) — fehlt er oder ist kein String → `''`.
 * **KEINE** Pfade/Secrets: nur Board-Story-`id` + Board-`title` + der
 * abgeleitete Übergang (NFR-Floor der Spec). Ohne End-Projekt (Board-Scan
 * fehlgeschlagen / Projekt ohne Board / kein Lauf) sind beide Listen **leer**
 * (AC2, kein Crash). Eine Story, die während des Drains nur `To Do →
 * In Progress` (aber **nicht** `Done`) wechselte, erscheint in **keiner**
 * Liste (AC2). Nur Stories, die im Anfangs-Snapshot bereits bekannt waren,
 * gelten als "übergegangen" (eine im Endzustand neu erschienene Story ist
 * keine beobachtbare Transition dieses Drains).
 *
 * @param {Map<string, string|null>} initialStatuses  storyId → Status VOR der ersten Runde
 * @param {import('./BoardAggregator.js').ProjectEntry|null} endProject  letzter Board-Scan (oder null)
 * @returns {{
 *   completed: { id: string, title: string }[],
 *   blocked: { id: string, title: string }[]
 * }}
 */
export function computeCompletedBlocked(initialStatuses, endProject) {
  const completed = [];
  const blocked = [];
  if (!endProject) return { completed, blocked };
  for (const story of flattenProjectStories(endProject)) {
    const before = initialStatuses.get(story.id);
    if (before === undefined) continue; // beim Start unbekannt → keine beobachtbare Transition
    const endStatus = story.status ?? null;
    const title = typeof story.title === 'string' ? story.title : '';
    if (before !== 'Done' && endStatus === 'Done') {
      completed.push({ id: story.id, title });
    } else if (before !== 'Blocked' && endStatus === 'Blocked') {
      blocked.push({ id: story.id, title });
    }
  }
  return { completed, blocked };
}

// ── ProjectDrain ───────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {import('./BoardAggregator.js').BoardAggregator} deps.boardAggregator  read-only Status-Quelle
 * @param {{ tryRun: Function, getStatus: () => { commandId: string|null, status: string|null } }} [deps.commandService]
 *   Nur noch für die AC7-Busy-Erkennung (`isProjectBusy()`) verwendet — der
 *   Ausführungs-Schritt selbst geht über `deps.flowRunner` (S-212). Wird
 *   `flowRunner` NICHT übergeben, baut der Konstruktor per Default einen
 *   `InteractiveFlowRunner` um dieses `commandService` (AC6, bit-identisches
 *   Verhalten zum bisherigen hart-verdrahteten Pfad).
 * @param {{ startRun: Function, awaitCompletion: Function }} [deps.flowRunner]
 *   injizierbares `FlowRunner`-Interface (`src/FlowRunner.js`, AC4/AC5) für
 *   den Ausführungs-Schritt. Default: `InteractiveFlowRunner` um
 *   `deps.commandService` (AC6). Ein `HeadlessFlowRunnerAdapter` kann hier
 *   für den Nacht-Drain injiziert werden (Verdrahtung selbst ist S-213,
 *   NICHT Teil dieser Story).
 * @param {{ setBlocked: Function }} [deps.boardWriter]  Eskalations-Schreibpfad (AC4/AC8)
 * @param {import('./ProjectJobLock.js').ProjectJobLock} [deps.lock]  default: Singleton `projectJobLock`
 * @param {{ hasSession: (p: string) => boolean }} [deps.sessionRegistry]  für Busy-Erkennung (AC7)
 * @param {{ record: Function }} [deps.auditStore]  Drain-Start + Eskalation (AC18)
 * @param {{
 *   checkProactive: (p: { nowMs: number }) => Promise<{ pause: boolean, reason?: string, resumeAt?: number|null }>,
 *   noteReset: (resetAt: number) => void,
 *   awaitResume: (p: { resumeAt: number|null, windowEndMs: number|null, nowMs: number }) =>
 *     Promise<{ resumed: true, from: number, to: number } | { resumed: false, reason: 'budget-window-end'|'budget-stop', from: number }>,
 * }} [deps.budgetGuard]  optional (docs/specs/night-budget-guard.md AC5/AC9-AC11, konkrete
 *   Implementierung S-274) — proaktive Schwellen-Prüfung VOR jeder Flow-Runde. Ohne ihn ist
 *   der proaktive Schutz ein No-op (AC8/A4); der reaktive Schutz (AC4) ist davon unabhängig.
 * @param {number} [deps.staleInProgressHours]  default: DEFAULT_STALE_IN_PROGRESS_HOURS (4)
 * @param {number} [deps.escalationAttempts]    default: DEFAULT_ESCALATION_ATTEMPTS (3)
 * @param {number} [deps.pollIntervalMs]        Poll-Intervall des Default-`InteractiveFlowRunner`s
 * @param {number} [deps.safetyMaxNoProgressRounds]  Sicherheitsgürtel-Obergrenze
 *   (Defense-in-Depth, S-192 Review-Iteration 2), default:
 *   DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS (50)
 * @param {number} [deps.budgetResumeBufferMs]  Fortsetzungs-Puffer nach einem reaktiv
 *   erkannten `resetAt` (night-budget-guard A3/AC4), default: BUDGET_RESUME_BUFFER_MS (~5 min)
 * @param {(ms: number) => Promise<void>} [deps.sleepFn]  injectable für Tests (Default-`InteractiveFlowRunner` UND das reaktive Budget-Warten)
 * @param {() => number} [deps.now]  injectable Uhr (ms epoch) für Tests
 */
export class ProjectDrain {
  #boardAggregator;
  #commandService;
  #flowRunner;
  #boardWriter;
  #lock;
  #sessionRegistry;
  #auditStore;
  #budgetGuard;
  #staleInProgressHours;
  #escalationAttempts;
  #safetyMaxNoProgressRounds;
  #budgetResumeBufferMs;
  #sleepFn;
  #now;

  constructor({
    boardAggregator,
    commandService,
    flowRunner,
    boardWriter,
    lock = projectJobLock,
    sessionRegistry,
    auditStore,
    budgetGuard,
    staleInProgressHours = DEFAULT_STALE_IN_PROGRESS_HOURS,
    escalationAttempts = DEFAULT_ESCALATION_ATTEMPTS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    safetyMaxNoProgressRounds = DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS,
    budgetResumeBufferMs = BUDGET_RESUME_BUFFER_MS,
    sleepFn,
    now,
  } = {}) {
    this.#boardAggregator = boardAggregator;
    // AC7: weiterhin gehalten für isProjectBusy() — unabhängig vom
    // Ausführungs-Schritt (der über #flowRunner läuft, s.u.).
    this.#commandService = commandService ?? null;
    // AC4/AC5/AC6: Default = InteractiveFlowRunner um `commandService`
    // (bit-identisches Verhalten zum bisherigen hart-verdrahteten Pfad).
    // Ein injizierter `flowRunner` (z.B. HeadlessFlowRunnerAdapter, S-213)
    // ersetzt NUR den Ausführungs-Schritt, keine sonstige Logik.
    this.#flowRunner = flowRunner ?? new InteractiveFlowRunner({ commandService, sleepFn, pollIntervalMs });
    this.#boardWriter = boardWriter ?? null;
    this.#lock = lock;
    this.#sessionRegistry = sessionRegistry ?? null;
    this.#auditStore = auditStore ?? null;
    // night-budget-guard AC5/AC9-AC11: optional — ohne ihn ist die
    // proaktive Prüfung ein No-op (AC8, kein Regress). Der reaktive Schutz
    // (AC4) braucht keinen budgetGuard (immer aktiv, AC11).
    this.#budgetGuard = budgetGuard ?? null;
    this.#staleInProgressHours = staleInProgressHours > 0 ? staleInProgressHours : DEFAULT_STALE_IN_PROGRESS_HOURS;
    this.#escalationAttempts = escalationAttempts > 0 ? escalationAttempts : DEFAULT_ESCALATION_ATTEMPTS;
    this.#safetyMaxNoProgressRounds =
      safetyMaxNoProgressRounds > 0 ? safetyMaxNoProgressRounds : DEFAULT_SAFETY_MAX_NO_PROGRESS_ROUNDS;
    this.#budgetResumeBufferMs = budgetResumeBufferMs >= 0 ? budgetResumeBufferMs : BUDGET_RESUME_BUFFER_MS;
    // Eigenständig gehalten (nicht nur an InteractiveFlowRunner durchgereicht) —
    // das reaktive Budget-Warten (AC4) läuft IM Drain selbst, unabhängig vom
    // injizierten FlowRunner-Adapter.
    this.#sleepFn = sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = now ?? (() => Date.now());
  }

  /**
   * Drained EIN Projekt: stößt `/agent-flow:flow` wiederholt an, bis die
   * Abbruch-/Konvergenz-Regel greift (AC1/AC2). Eskaliert progresslose
   * Drain-Ziel-Stories nach `escalationAttempts` Läufen (AC4/AC5).
   *
   * @param {string} projectPath  absoluter Projektpfad (Schlüssel von
   *   `ProjectJobLock`/`BoardAggregator.repo_path`/`isProjectBusy`).
   * @param {object} [opts]
   * @param {string|null} [opts.identity]  auslösende Identität (Audit + CommandService).
   * @param {string[]} [opts.args]  zusätzliche argv-Elemente, die an JEDEN
   *   `/agent-flow:flow`-Anstoß dieses Drains durchgereicht werden
   *   (`flowRunner.startRun({ args })`, docs/specs/headless-manual-drain.md AC3).
   *   Z.B. `['--cost', 'low-cost']` für den Cost-Mode-Hebel des manuellen
   *   Headless-Knopfs. Gilt für ALLE Flow-Runden desselben Drains. Der
   *   `InteractiveFlowRunner` ignoriert `args` (interaktiver Pfad kennt keinen
   *   `--cost`-Hebel); der `HeadlessFlowRunnerAdapter` reicht sie an den
   *   `claude -p '/agent-flow:flow …'`-Kindprozess durch. Default: `[]`.
   * @param {number|null} [opts.windowEndMs]  vom Scheduler übergebenes Nacht-
   *   Fenster-Ende (ms epoch, docs/specs/night-budget-guard.md AC6/A2). `null`
   *   (Default) = kein Fenster (manueller Drain) — eine reaktive Budget-Pause
   *   wartet dann regulär, eine proaktive ohne bekannten Reset endet sanft
   *   (`reason:'budget-stop'`).
   * @returns {Promise<{
   *   stopped: true,
   *   reason: 'no-drain-target'|'already-busy'|'command-channel-busy'|'safety-stop-no-progress'|'scan-failed'|'budget-window-end'|'budget-stop',
   *   flowRuns: number,
   *   escalated: string[],
   *   completed: { id: string, title: string }[],
   *   blocked: { id: string, title: string }[],
   *   budgetPauses: { from: number, to: number|null, reason: 'reactive-limit'|'proactive-threshold' }[]
   * }>}
   *   `completed`/`blocked` (docs/specs/drain-completion-report.md AC1/AC2):
   *   während dieses Drains nach `Done` bzw. `Blocked` übergegangene Stories
   *   (Anfangs-/End-Snapshot-Diff, `computeCompletedBlocked`). Bei
   *   `already-busy`/`scan-failed`/`command-channel-busy` oder `flowRuns==0`
   *   sind beide Listen leer (kein Crash). `blocked` ist eine Obermenge von
   *   `escalated`. Kein Pfad/Secret in `title`. `budgetPauses`
   *   (docs/specs/night-budget-guard.md AC4/AC5/AC6, chronologisch, additiv
   *   auf JEDEM Rückgabepfad — leer `[]`, wenn keine Budget-Pause auftrat):
   *   `to=null` bedeutet, die Pause hat den Drain sanft beendet
   *   (`reason:'budget-window-end'|'budget-stop'`).
   */
  async drainProject(projectPath, opts = {}) {
    const identity = opts.identity ?? null;
    // AC3: per-Drain durchgereichte argv (z.B. ['--cost', <mode>]) — gilt für
    // ALLE Flow-Runden dieses Drains. Defensiv auf ein Array normalisiert.
    const args = Array.isArray(opts.args) ? opts.args : [];
    // night-budget-guard AC6/A2: null = kein Fenster (manueller Drain).
    const windowEndMs = typeof opts.windowEndMs === 'number' ? opts.windowEndMs : null;

    // AC6/AC7: Busy-Check + eigenes Lock — KEIN await dazwischen (Node
    // Single-Thread-Event-Loop ⇒ atomar, kein Doppel-Trigger-Race).
    if (
      isProjectBusy(projectPath, {
        lock: this.#lock,
        commandService: this.#commandService,
        sessionRegistry: this.#sessionRegistry,
      })
    ) {
      return {
        stopped: true,
        reason: 'already-busy',
        flowRuns: 0,
        escalated: [],
        completed: [],
        blocked: [],
        budgetPauses: [],
      };
    }
    if (!this.#lock.tryAcquire(projectPath)) {
      return {
        stopped: true,
        reason: 'already-busy',
        flowRuns: 0,
        escalated: [],
        completed: [],
        blocked: [],
        budgetPauses: [],
      };
    }

    try {
      this.#auditRecord(identity, `taktgeber:drain-start project=${projectPath}`);
      return await this.#runLoop(projectPath, identity, args, windowEndMs);
    } finally {
      // Edge-Case "Projekt-Lock bei Crash": Lock wird IMMER freigegeben,
      // auch bei einem Fehler irgendwo in #runLoop (kein Dauer-Lock).
      this.#lock.release(projectPath);
    }
  }

  /**
   * Haupt-Drain-Schleife (AC1/AC2 Abbruch-Regel, AC4/AC5 Eskalation,
   * Sicherheitsgürtel Defense-in-Depth — siehe Modul-Doku).
   * @param {string} projectPath
   * @param {string|null} identity
   * @param {string[]} [args]  per-Drain durchgereichte argv (AC3, s. drainProject).
   * @param {number|null} [windowEndMs]  Nacht-Fenster-Ende (night-budget-guard AC6, s. drainProject).
   * @returns {Promise<{
   *   stopped: true,
   *   reason: 'no-drain-target'|'command-channel-busy'|'safety-stop-no-progress'|'scan-failed'|'budget-window-end'|'budget-stop',
   *   flowRuns: number,
   *   escalated: string[],
   *   completed: { id: string, title: string }[],
   *   blocked: { id: string, title: string }[],
   *   budgetPauses: { from: number, to: number|null, reason: 'reactive-limit'|'proactive-threshold' }[]
   * }>}
   */
  async #runLoop(projectPath, identity, args = [], windowEndMs = null) {
    let flowRuns = 0;
    let consecutiveNoProgress = 0;
    // AC1/AC2 (drain-completion-report): Anfangs-Status-Snapshot (Status je
    // Story-ID VOR der ersten Flow-Runde), einmalig beim ersten Scan erfasst.
    // Der End-Snapshot ist der jeweils letzte Board-Scan am Return-Punkt; der
    // Diff (`computeCompletedBlocked`) liefert completed/blocked. Additive
    // Erfassung — keine Änderung an Ziel-Auswahl/Konvergenz/Eskalation.
    /** @type {Map<string, string|null>|null} */
    let initialStatuses = null;
    // Sicherheitsgürtel-Zähler (Defense-in-Depth, S-192 Iteration 2):
    // unabhängig von couldBecomeReady/Eskalation, NIE durch die Eskalations-
    // Logik zurückgesetzt — nur durch echten beobachteten Fortschritt.
    let totalNoProgressRounds = 0;
    let round = 0;
    /** @type {Map<string, number>} storyId → Runde der letzten beobachteten Zustandsänderung */
    const lastChangeRound = new Map();
    /** @type {string[]} */
    const escalated = [];
    // night-budget-guard AC4/AC5/AC6: additiv auf JEDEM Rückgabepfad (leer,
    // wenn nie eine Budget-Pause auftrat — kein Regress an bestehenden Feldern).
    /** @type {{ from: number, to: number|null, reason: 'reactive-limit'|'proactive-threshold' }[]} */
    const budgetPauses = [];

    for (;;) {
      // Event-Loop-Yield (Defense-in-Depth gegen 100%-CPU-Spin, s. Modul-
      // Doku): garantiert einen ECHTEN Makrotask-Tick pro Runde, unabhängig
      // davon ob #findProject/tryRun/getStatus synchron sofort resolvieren —
      // verhindert, dass eine rein Microtask-getriebene Schleife den
      // Event-Loop verhungern lässt (live beobachtet: >2 Min. 100% CPU).
      await this.#yieldTick();

      const { project, scanFailed } = await this.#findProject(projectPath);
      const state = computeDrainState(project, this.#now(), this.#staleInProgressHours);

      // AC1/AC2: Anfangs-Status-Snapshot genau einmal erfassen — der erste
      // Scan ist der Zustand VOR der ersten Flow-Runde.
      if (initialStatuses === null) {
        initialStatuses = new Map();
        for (const [id, snap] of state.snapshot) initialStatuses.set(id, snap.status);
      }

      // AC2: Abbruch-/Konvergenz-Regel
      if (state.targets.length === 0 && !state.couldBecomeReady) {
        // AC1/AC2: End-Snapshot = dieser (letzte) Scan. Bei scan-failed ist
        // `project` null → leere Bilanz (AC2). `no-drain-target` liefert die
        // während des Drains erledigten/blockierten Stories.
        const { completed, blocked } = computeCompletedBlocked(initialStatuses, scanFailed ? null : project);
        return {
          stopped: true,
          reason: scanFailed ? 'scan-failed' : 'no-drain-target',
          flowRuns,
          escalated,
          completed,
          blocked,
          budgetPauses,
        };
      }

      // night-budget-guard AC5: proaktive Prüfung VOR jeder Flow-Runde
      // (Story-Grenze) — nur, wenn ein budgetGuard injiziert ist (sonst No-op,
      // AC8/A4). Bei Pause startet KEINE Flow-Runde (kein flowRuns-Increment,
      // kein round-Increment) und es wird KEIN Eskalations-Zähler berührt (AC7).
      if (this.#budgetGuard) {
        let proactive = null;
        try {
          proactive = await this.#budgetGuard.checkProactive({ nowMs: this.#now() });
        } catch {
          // Robustheit (NFR): ein Guard-/Meter-Fehler darf den Drain nicht
          // crashen — im Zweifel NICHT pausieren (proactive bleibt null).
        }
        if (proactive && proactive.pause) {
          const pauseFrom = this.#now();
          const outcome = await this.#awaitBudgetResume({
            resumeAt: typeof proactive.resumeAt === 'number' ? proactive.resumeAt : null,
            windowEndMs,
          });
          budgetPauses.push({
            from: pauseFrom,
            to: outcome.resumed ? outcome.to : null,
            reason: 'proactive-threshold',
          });
          if (!outcome.resumed) {
            const { completed, blocked } = computeCompletedBlocked(initialStatuses, scanFailed ? null : project);
            return {
              stopped: true,
              reason: outcome.reason,
              flowRuns,
              escalated,
              completed,
              blocked,
              budgetPauses,
            };
          }
          continue; // resumed → frischer Board-Scan am Schleifenanfang
        }
      }

      round += 1;
      for (const target of state.targets) {
        if (!lastChangeRound.has(target.id)) lastChangeRound.set(target.id, round);
      }

      // AC1: /agent-flow:flow anstoßen — über das injizierte FlowRunner-
      // Interface (S-212 AC4/AC5; CommandService auditiert den akzeptierten
      // interaktiven Aufruf bereits selbst — AC18 "jeder /flow-Anstoß").
      flowRuns += 1;
      // AC3: `args` (z.B. ['--cost', <mode>]) an JEDEN Flow-Anstoß durchreichen.
      // Der InteractiveFlowRunner ignoriert `args`; der HeadlessFlowRunnerAdapter
      // hängt sie an den `claude -p '/agent-flow:flow …'`-Kindprozess (headless-manual-drain AC3).
      const startResult = this.#flowRunner.startRun({ projectPath, command: FLOW_COMMAND, identity, args });

      // Lock-Contention-Fix (S-195 Review-Iteration 2, live verifiziert
      // critical — siehe Modul-Doku): `reason: 'locked'|'busy'` bedeutet, es
      // fand GAR KEIN /flow-Lauf statt — beim interaktiven Adapter, weil der
      // globale CommandService-JobLock gerade von einem ANDEREN Projekt
      // gehalten wird (headless-Adapter: praktisch ausgeschlossen, kein
      // globaler Lock, AC8). Das ist KEIN fortschrittsloser LAUF dieses
      // Projekts (kein `awaitCompletion`, kein Snapshot-Vergleich, keine
      // Eskalation) — sondern reine Ressourcen-Kontention außerhalb der
      // Kontrolle dieses Drains. Sofort sauber beenden (Lock-Freigabe
      // passiert wie immer in `finally` von `drainProject`), kein Spin,
      // keine Zustandsänderung an der Story. Das Projekt bleibt Kandidat für
      // den nächsten Scheduler-Tick.
      if (startResult && !startResult.ok && (startResult.reason === 'locked' || startResult.reason === 'busy')) {
        // AC2 (drain-completion-report): Kontention = für DIESES Projekt fand
        // gar kein echter /flow-Lauf statt → leere completed/blocked-Bilanz
        // (Spec-mandatiert, kein Diff über einen unveränderten Board-Zustand).
        return {
          stopped: true,
          reason: 'command-channel-busy',
          flowRuns,
          escalated,
          completed: [],
          blocked: [],
          budgetPauses,
        };
      }

      let awaitResult = { status: 'done' };
      if (startResult && startResult.ok) {
        awaitResult = await this.#flowRunner.awaitCompletion(startResult.handle);
      }

      // night-budget-guard AC4/AC7: reaktive Limit-Meldung — gilt NIE als
      // fortschrittsloser Lauf (weder consecutiveNoProgress/totalNoProgressRounds
      // noch setBlocked werden berührt). Braucht KEINEN injizierten budgetGuard
      // (immer aktiv, AC11) — `noteReset` wird nur aufgerufen, falls einer da ist.
      if (awaitResult && awaitResult.status === 'budget-limited') {
        const resetAt = typeof awaitResult.resetAt === 'number' ? awaitResult.resetAt : null;
        if (resetAt !== null) {
          if (this.#budgetGuard && typeof this.#budgetGuard.noteReset === 'function') {
            try {
              this.#budgetGuard.noteReset(resetAt);
            } catch {
              // best-effort — kein Crash (Robustheits-NFR)
            }
          }
          const pauseFrom = this.#now();
          const resumeAt = resetAt + this.#budgetResumeBufferMs;
          if (windowEndMs !== null && resumeAt > windowEndMs) {
            // A2: Fortsetzungs-Zeitpunkt liegt hinter dem Fenster-Ende → sanftes
            // Ende statt zu warten (AC6).
            budgetPauses.push({ from: pauseFrom, to: null, reason: 'reactive-limit' });
            const { project: projectAfterLimit } = await this.#findProject(projectPath);
            const { completed, blocked } = computeCompletedBlocked(initialStatuses, projectAfterLimit);
            return {
              stopped: true,
              reason: 'budget-window-end',
              flowRuns,
              escalated,
              completed,
              blocked,
              budgetPauses,
            };
          }
          // Edge-Case "Reset-Zeit in der Vergangenheit": Wartezeit nie negativ.
          const waitMs = Math.max(resumeAt - pauseFrom, 0);
          await this.#sleepFn(waitMs);
          budgetPauses.push({ from: pauseFrom, to: this.#now(), reason: 'reactive-limit' });
        }
        // Edge-Case "budget-limited ohne resetAt" (dürfte laut S-270 AC3 nicht
        // auftreten): kein Warten (kein bekannter Reset), aber AC7 hat Vorrang —
        // KEIN Eskalations-Zähler-Increment, `continue` unten überspringt ihn.
        continue; // frischer Board-Scan am Schleifenanfang, nie fortschrittslos gezählt
      }

      const { project: projectAfter } = await this.#findProject(projectPath);
      const stateAfter = computeDrainState(projectAfter, this.#now(), this.#staleInProgressHours);

      // AC5: Fortschritt = jede Status-/Ready-Änderung zwischen zwei Scans
      // (volles Projekt-Snapshot-Diff, Muster NotificationWatcher).
      const progressed = !snapshotsEqual(state.snapshot, stateAfter.snapshot);
      for (const [id, val] of stateAfter.snapshot) {
        const prev = state.snapshot.get(id);
        if (!prev || prev.status !== val.status || prev.ready !== val.ready) {
          lastChangeRound.set(id, round);
        }
      }

      if (progressed) {
        consecutiveNoProgress = 0;
        totalNoProgressRounds = 0;
      } else {
        consecutiveNoProgress += 1;
        totalNoProgressRounds += 1;

        if (consecutiveNoProgress >= this.#escalationAttempts) {
          if (stateAfter.targets.length > 0 && projectAfter) {
            const victim = pickLongestUnmovedTarget(stateAfter.targets, lastChangeRound);
            if (victim) {
              const ok = await this.#escalate(projectAfter, victim, identity);
              if (ok) {
                escalated.push(victim.id);
                lastChangeRound.delete(victim.id);
                // Eskalation ändert selbst den Status einer Story (→ Blocked)
                // — das IST ein Drain-Fortschritt im Sinne des
                // Sicherheitsgürtels (siehe Modul-Doku), auch wenn er sich
                // erst in der NÄCHSTEN Runde im state-Snapshot zeigt. Ohne
                // diesen Reset würde ein Board mit vielen aufeinanderfolgend
                // eskalierten Stories den Sicherheitsgürtel fälschlich
                // auslösen, obwohl jede Eskalation echten Fortschritt macht.
                totalNoProgressRounds = 0;
              }
            }
          }
          // consecutiveNoProgress IMMER zurücksetzen — auch wenn aktuell kein
          // Drain-Ziel zum Eskalieren existiert (couldBecomeReady-only-Runde,
          // s. Modul-Doku) oder der Schreibversuch fehlschlug (kein
          // Tight-Retry-Loop). totalNoProgressRounds NICHT zurücksetzen in
          // diesen beiden Fehlerfällen — genau DAS ist der Pfad, gegen den
          // der Sicherheitsgürtel schützen soll (z.B. fehlender boardWriter).
          consecutiveNoProgress = 0;
        }

        // Sicherheitsgürtel (Defense-in-Depth, NICHT die primäre AC2-Regel —
        // siehe Modul-Doku): harter Notausstieg, unabhängig davon ob gerade
        // eskaliert wird/werden kann. Greift bei korrekter Logik (a) nie,
        // schützt aber gegen unvorhergesehene künftige Logikfehler (z.B.
        // fehlender boardWriter, sodass Eskalationen nie Fortschritt machen).
        if (totalNoProgressRounds >= this.#safetyMaxNoProgressRounds) {
          // AC1/AC2: End-Snapshot = letzter Post-Flow-Scan (`projectAfter`).
          const { completed, blocked } = computeCompletedBlocked(initialStatuses, projectAfter);
          return {
            stopped: true,
            reason: 'safety-stop-no-progress',
            flowRuns,
            escalated,
            completed,
            blocked,
            budgetPauses,
          };
        }
      }
    }
  }

  /**
   * Wartet auf die Fortsetzung nach einer PROAKTIVEN Budget-Pause (night-
   * budget-guard AC5/AC6) — delegiert an den injizierten `budgetGuard`
   * (`awaitResume`, konkrete Wartelogik + A1/A2-Entscheidung liegt dort,
   * S-274). Ein Guard-Fehler ist degradierend (Robustheits-NFR): im Zweifel
   * wird NICHT weiter pausiert, sondern sofort fortgesetzt (kein Crash, kein
   * unbegrenztes Hängen).
   *
   * @param {{ resumeAt: number|null, windowEndMs: number|null }} params
   * @returns {Promise<{ resumed: true, to: number } | { resumed: false, reason: 'budget-window-end'|'budget-stop' }>}
   */
  async #awaitBudgetResume({ resumeAt, windowEndMs }) {
    try {
      const outcome = await this.#budgetGuard.awaitResume({ resumeAt, windowEndMs, nowMs: this.#now() });
      if (outcome && outcome.resumed) {
        return { resumed: true, to: typeof outcome.to === 'number' ? outcome.to : this.#now() };
      }
      // Defensiver Fallback, falls ein Guard `reason` nicht (korrekt) setzt:
      // A2 — kein Fenster ⇒ 'budget-stop', sonst 'budget-window-end' (AC6).
      const fallbackReason = windowEndMs === null ? 'budget-stop' : 'budget-window-end';
      const reason =
        outcome && (outcome.reason === 'budget-stop' || outcome.reason === 'budget-window-end')
          ? outcome.reason
          : fallbackReason;
      return { resumed: false, reason };
    } catch {
      // Robustheit (NFR): ein Fehler im budgetGuard darf den Drain nicht
      // crashen — im Zweifel NICHT pausieren (sofort fortsetzen).
      return { resumed: true, to: this.#now() };
    }
  }

  /**
   * Setzt die am längsten unbewegte Drain-Ziel-Story auf `Blocked`
   * (AC4, einziger Schreibpfad: `BoardWriter.setBlocked`).
   *
   * @param {import('./BoardAggregator.js').ProjectEntry} project
   * @param {import('./BoardAggregator.js').StoryEntry} victim
   * @param {string|null} identity
   * @returns {Promise<boolean>} true bei Erfolg
   */
  async #escalate(project, victim, identity) {
    if (!this.#boardWriter) return false;
    const reason = `Taktgeber: ${this.#escalationAttempts}x kein Fortschritt`;
    try {
      await this.#boardWriter.setBlocked({
        projectSlug: project.slug,
        storyId: victim.id,
        blockedReason: reason,
      });
    } catch {
      // Defensive: ein fehlgeschlagener Eskalations-Schreibversuch darf den
      // Drain nicht crashen (Robustheits-NFR, analog ReconciliationJob).
      return false;
    }
    this.#auditRecord(identity, `taktgeber:escalate story=${victim.id} project=${project.slug} reason="${reason}"`);
    return true;
  }

  /**
   * Garantiert einen echten Makrotask-Tick (`setImmediate`, NICHT
   * Microtask/`Promise.resolve()`), unabhängig vom injizierbaren `sleepFn`
   * der Completion-Polling-Logik. Defense-in-Depth gegen einen
   * Microtask-getriebenen Tight-Loop, falls `#findProject`/`tryRun`/
   * `getStatus` je in einer künftigen Logikänderung synchron sofort
   * resolvieren würden (s. Modul-Doku, live beobachtetes >2-Min.-100%-CPU-
   * Verhalten der Single-Hop-Vorgängerversion).
   * @returns {Promise<void>}
   */
  #yieldTick() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  /**
   * Findet den Projekt-Index-Eintrag für `projectPath` per frischem Scan.
   * Unterscheidet (S-192 Review-Iteration 2 Suggestion) im Rückgabewert
   * "wirklich leer/nicht gefunden" von "Scan fehlgeschlagen" (eigenes
   * `scanFailed`-Flag), damit ein späterer Scheduler (S-195) bei einem
   * transienten Scan-Fehler sinnvoll erneut versuchen kann, statt das
   * Projekt fälschlich als endgültig leer zu behandeln. Crash-Verhalten
   * unverändert: Board-Scan-Fehler → `project: null` (Edge-Case
   * "Board-Scan-Fehler": Projekt wird in diesem Tick übersprungen, kein
   * Crash) — nur das `scanFailed`-Flag ist neu.
   * @param {string} projectPath
   * @returns {Promise<{
   *   project: import('./BoardAggregator.js').ProjectEntry|null,
   *   scanFailed: boolean
   * }>}
   */
  async #findProject(projectPath) {
    let index;
    try {
      await this.#boardAggregator.scan();
      index = await this.#boardAggregator.getIndex();
    } catch {
      return { project: null, scanFailed: true };
    }
    if (!Array.isArray(index)) return { project: null, scanFailed: true };
    const project = index.find((p) => !p.error && p.repo_path === projectPath) ?? null;
    return { project, scanFailed: false };
  }

  /**
   * Best-effort Audit-Eintrag (AC18). Ein Audit-Fehler darf den Drain selbst
   * nicht crashen — anders als bei `CommandService.tryRun()` (dort gate-haltend
   * für die Befehlsausführung, AC6 flow-trigger) handelt es sich hier um
   * begleitende Buchführung des Taktgebers, kein Sicherheits-Gate.
   * @param {string|null} identity
   * @param {string} command
   */
  #auditRecord(identity, command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity, command });
    } catch {
      // best-effort — kein Crash
    }
  }
}
