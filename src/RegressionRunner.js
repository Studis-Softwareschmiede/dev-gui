/**
 * RegressionRunner — deterministischer Regressionstest-Runner (`npx playwright
 * test`, KEIN Agent, KEIN `claude`-Kindprozess) mit eigenem `ProjectJobLock`,
 * Busy-Check, local-Erreichbarkeitsprüfung, Frisch-Ausrollen + Selbsttest-Skip
 * und Ergebnis-Übergabe an den `RegressionResultStore`
 * (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC7, AC8, AC9).
 *
 * Producer-Naht (docs/specs/regression-failed-notification.md AC1–AC4, S-315):
 * bei Lauf-Abschluss mit `status:"failed"` (aus `summarizeCtrf()`, ECHTE rote
 * Testfälle) stößt dieses Modul best-effort GENAU EINEN `regression_failed`-
 * Push über den injizierten `notifier` (`DrainNotifier#notifyRegressionFailed`,
 * GETEILTE Instanz — kein neuer Notify-Pfad) an. `precondition-error`/`error`
 * (Vorbedingungs-/Runner-Fehler, keine Test-Regression) lösen NIE einen Push
 * aus — diese Zustände erreichen den Notify-Aufruf strukturell nicht (nur der
 * `summarizeCtrf()`-Pfad tut es, s. `#runLifecycle`). Ohne injizierten
 * `notifier` degradiert der Runner auf reines Lauf-Ergebnis ohne Push (kein
 * Crash, Default-Regress).
 *
 * Zentraler Unterschied zu ALLEN anderen Runnern in diesem Repo (Grep-prüfbar):
 * dieses Modul importiert/spawnt **kein** `claude` — es startet ausschließlich
 * `npx playwright test` im Projekt-Klon. Kein API-Key, kein
 * `HeadlessRunnerCore`/`buildChildEnv`-Import (der ist `claude`-spezifisch).
 *
 * Eigener Boundary (AC1):
 *   - EIGENE, isolierte `ProjectJobLock`-Instanz (Konstruktor-Default
 *     `new ProjectJobLock()`) — getrennt von ALLEN `claude -p`-Runnern
 *     (Nacht-Drain/manueller Drain/Reconcile/Finalizer/Auto-Retro/
 *     ObsidianIngestRunner/RegressionDefineRunner). Ein laufender
 *     Definitions-/Drain-Lauf blockiert einen Regressionslauf NICHT über
 *     dieses Lock — die Busy-Prüfung gegen Drains läuft separat (AC2, s.u.).
 *   - Audit-First: der AUFRUFENDE Router schreibt den Start-Audit-Eintrag VOR
 *     `start()` (Muster `regressionDefineRouter`); dieses Modul selbst
 *     auditiert Ende/Fehler (secret-frei).
 *   - Entkoppelter Runaway-Timeout (`REGRESSION_RUN_TIMEOUT_MS`, eigenständig,
 *     NICHT an `REGRESSION_DEFINE_TIMEOUT_MS` o.ä. gekoppelt — ein Playwright-
 *     Lauf hat ein anderes Zeitprofil als ein `claude`-Definitions-Turn).
 *
 * Busy-Check (AC2): `isProjectBusy()` (ProjectJobLock.js) wird VOM ROUTER rein
 * lesend geprüft (Drain-Lock + Command-Status + Session-Existenz) UND
 * zusätzlich gegen das EIGENE `RegressionRunner`-Lock (ein zweiter
 * Regressionslauf desselben Projekts) — kein Doppel-Start, kein Doppel-Trigger.
 *
 * Security/Access (AC3): dieser Runner selbst prüft KEINE Identität/Rolle —
 * das ist Router-Verantwortung (gleiche `CRED_ADMIN_EMAILS`-Logik wie
 * `deploymentsRouter`/`vpsContainerRouter`, s. `regressionRunRouter.js`).
 * Kein Secret/Token in Job-Status, Log oder Audit.
 *
 * Testobjekt/`target`-Auflösung + local-Erreichbarkeit (AC5, agent-flow
 * `regression-runner` AC6): der Runner selbst entscheidet NICHT, welche Suite
 * welches `target` deklariert (das lebt in der Begleitbeschreibung, AC4/AC6
 * sind spätere Storys/Frontend, s. Spec-Nicht-Ziele dieser Story) — er prüft
 * VOR jedem Lauf, der `local`-Suiten enthalten KANN (Bereich/Verbund/Gesamt,
 * konservativ: immer), ob die lokale Applikation erreichbar ist:
 * `http://127.0.0.1:<port>/`, Port aus `.claude/profile.md` (`preview_port`,
 * Fallback `container_port`) des Projekt-Klons. Nicht erreichbar → sofortiger
 * `precondition-error` MIT Grund „Applikation lokal nicht gestartet" — KEIN
 * Playwright-Start (kein roter Testlauf für einen Vorbedingungsfehler).
 * Frisch-Ausrollen & Selbsttest (AC7, AC8, S-310): bei `target: local` UND
 * `freshRollout: true` UND NICHT Selbsttest zieht der Runner VOR der
 * Erreichbarkeitsprüfung das aktuelle ghcr-Image des Projekts und erstellt den
 * lokalen Container NEU (pull + recreate, niemals `restart`) über die
 * bestehende `LocalDockerControl#pullAndRecreate`-Methode (Wiederverwendung
 * der cicd/preview-Rollout-Mechanik, kein neuer Rollout-Pfad) — danach erst
 * die lauf-übliche Erreichbarkeitsprüfung (AC5). Selbsttest-Sonderfall (AC8):
 * ist das Testobjekt-Projekt (`projekt`-Slug, s. `start()`) DIESES Projekt
 * (dev-gui, Selbst-Erkennung über `SELF_PROJECT_SLUG`), wird Frisch-Ausrollen
 * SERVERSEITIG hart übersprungen — unabhängig vom übergebenen `freshRollout`-
 * Wert (Edge-Case „Selbsttest mit aktivierter Option via direktem API-Aufruf")
 * — ein recreate würde den eigenen Runner-Prozess mitsamt Lauf beenden. Ohne
 * injizierte `dockerControl` (Default: keine) wird Frisch-Ausrollen ebenfalls
 * übersprungen (kein Crash, degradiert auf reine Erreichbarkeitsprüfung).
 *
 * Ausführung & Ergebnis-Übergabe (AC9): `npx playwright test <scopePath>` wird
 * als Array-argv gestartet (kein Shell-String, security/R03), `cwd` = der
 * bereits validierte, absolute Projekt-Pfad. Scope→Pfad-Zuordnung (Layout
 * gemäß agent-flow `regression-playwright-conventions` AC2):
 *   - `bereich`  → `tests/regression/<id>`      (Verzeichnis, alle Suiten darin)
 *   - `verbund`  → `tests/regression/verbund`   (EIN gemeinsames Verzeichnis für
 *                   alle Verbund-Suiten — der `verbund`-Name selektiert keine
 *                   eigene Unter-Datei, weil das Layout keinen weiteren
 *                   Namens-Unterordner vorsieht; s. SPEC-LÜCKE-Hinweis im
 *                   Handoff)
 *   - `gesamt`   → `tests/regression`           (gesamter Baum)
 * Nach Abschluss liest der Runner das CTRF-JSON-Ergebnis aus
 * `test-results/ctrf-report.json` (Default-Ausgabepfad des Referenz-Templates
 * `templates/_shared/regression/playwright.config.ts`,
 * `playwright-ctrf-json-reporter` mit `outputDir: 'test-results'`) und übergibt
 * EINEN aggregierten Lauf-Datensatz an `RegressionResultStore.record()` (A1:
 * „Gesamt" = ein Datensatz, `suite`-Label = gewählter Scope). Debug-Artefakte
 * (`playwright-report/`, `test-results/`) werden NICHT mehr referenziert,
 * sondern vom Store selbst aus dem Projekt-Klon in seine eigene Lauf-Ablage
 * KOPIERT (S-327, docs/specs/regression-result-store.md AC3) — dieser Runner
 * übergibt dafür nur den validierten, absoluten Projekt-Klon-Pfad
 * (`artifactsSourceDir: job.projectPath`); OB + welche Artefakte tatsächlich
 * behalten werden (Rot/Grün-Default, Retention), entscheidet ausschließlich
 * der Store — dieser Runner selbst unterscheidet dafür nicht mehr nach Status.
 *
 * Kein Projekt-Klon / kein Playwright-Grundgerüst (Edge-Case, Spec §Edge-Cases):
 *   fehlt `tests/regression` im Klon → `error` mit dem Grund „kein
 *   Regressions-Grundgerüst" statt eines Crashs.
 *
 * Diagnose-Pflicht bei Frühausfall (AC10, S-326): `#finish` ist die EINZIGE
 * Naht zu einem terminalen Zustand (`passed`/`failed`/`precondition-error`/
 * `error`) UND persistiert selbst — strukturell, nicht per Aufzählung: jeder
 * künftige Frühausgang, der `#finish` ruft, bekommt die Persistenz automatisch
 * mit, ohne dass ein Aufrufer daran denken muss. Reihenfolge in `#finish`:
 * (1) Status setzen, (2) Lock freigeben, (3) Audit, (4) best-effort
 * Store-Schreibzugriff — Lock-Freigabe VOR dem Store-Schreibzugriff, damit ein
 * hängender/fehlschlagender Store NIE ein Lock hält. Ohne CTRF (Frühausfall)
 * wird `ctrf: null` übergeben (KEIN synthetisches Ersatz-CTRF,
 * [[regression-result-store]] AC1b) — `reason` ist bei `precondition-error`/
 * `error` gesetzt, bei `passed`/`failed` abwesend. Ein Store-Fehler verhindert
 * den Lauf-Abschluss nie (best-effort, s. `#persistToStore`).
 *
 * Testobjekt-Weiche (AC11, S-326): VOR dem lokalen Pfad löst `#resolveTarget`
 * das je Scope deklarierte `target` über DIESELBE Lese-Boundary wie der
 * Ausführen-Dialog (`RegressionSuiteReader#readRegressionSuites`, AC4/AC6 —
 * kein zweiter Parser). `gesamt` mischt Testobjekte und läuft IMMER über den
 * local-Pfad (Bestandsverhalten, AC11 letzter Satz) — dafür wird
 * `readRegressionSuites` gar nicht erst aufgerufen (kein unnötiges Datei-IO).
 * Für `bereich`/`verbund` gilt: kein deklariertes `target` (fehlende/unlesbare
 * Begleitbeschreibung, Suite nicht gefunden) → konservativ `local`
 * (unverändertes Bestandsverhalten); `local` → bestehender lokaler Pfad
 * (AC5/AC7/AC8); `ephemeral-infra` → **A3-Pfad** (`#runEphemeralInfra`, AC12,
 * s.u.); jeder andere Wert (`url`/ein unbekannter String) → weiterhin
 * SOFORTIGER, persistierter `error` „Testobjekt `<target>` wird noch nicht
 * unterstützt" — OHNE Playwright-Start, OHNE die local-Erreichbarkeitsprüfung.
 * Ein Fallback auf den local-Pfad ist ausgeschlossen (verifizierter Befund
 * 2026-07-08: die vps-Suite durchlief fälschlich die local-Prüfung und
 * meldete einen irreführenden Vorbedingungs-Fehler). Datenhygiene: `target`
 * kommt aus einer Repo-Datei, die dieser Runner nicht kontrolliert — nur
 * bekannte Werte (`local`/`ephemeral-infra`/`url`) werden wörtlich in die
 * Meldung übernommen, ein unbekannter Wert erzeugt eine generische Meldung
 * (`buildUnsupportedTargetMessage`).
 *
 * `ephemeral-infra`-Ausführungspfad (AC12, S-362): agent-flow
 * `regression-playwright-conventions` AC4 legt das Provisionier-/Teardown-
 * Fixture-Muster für Infra-Ketten VERBINDLICH auf die EINZELNE Playwright-
 * Suite (fixture-scoped `try/finally`, s. `tests/regression/vps/*.spec.ts`)
 * — NICHT auf den Runner (dev-gui darf die Infra-Leitplanken/`target`-
 * Semantik nicht neu definieren, Spec-Nicht-Ziel). `#runEphemeralInfra`
 * spiegelt das: es überspringt die `local`-Erreichbarkeitsprüfung (AC5) UND
 * das lokale Frisch-Ausrollen (AC7 ist lokal-exklusiv), setzt aber — wie eine
 * `local`-Suite — `REGRESSION_BASE_URL` auf die lokal erreichbare Applikation
 * (dieselbe Port-Auflösung, `#readPort`), weil bestehende `ephemeral-infra`-
 * Suiten (view-vps-Feature) über die dev-gui-eigene UI navigieren UND ihr
 * eigenes `rtest-*`-Wegwerf-Ziel selbst provisionieren/abbauen (Fixture-
 * Teardown, s.o.). ZUSÄTZLICH zu diesem In-Test-Teardown garantiert der
 * Runner selbst ein best-effort Sicherheitsnetz (`#cleanupEphemeralInfra`):
 * nach JEDEM Lauf-Ausgang (passed/failed/error/Timeout/interner Fehler) wird
 * EINMALIG über alle konfigurierten VPS-Provider gefegt und JEDE Maschine
 * mit `rtest-*`-Namenspräfix gelöscht — greift genau dann, wenn der
 * Runner-eigene Runaway-Timeout den Playwright-Kindprozess beendet, BEVOR
 * dessen eigener Fixture-Teardown laufen konnte (Produktiv-Allowlist AC7:
 * der Sweep rührt AUSSCHLIESSLICH `rtest-*`-Namen an, alles andere bleibt
 * unberührt). **Reihenfolge zwingend (Review-Fix Iteration 2):** der Sweep
 * läuft VOR `#finish()` — `#finish()` gibt synchron das `ProjectJobLock`
 * frei; würde das Lock schon VOR dem Sweep fallen, könnte ein sofort
 * gestarteter Folgelauf desselben Projekts (Busy-Check sieht „frei") seine
 * frische `rtest-*`-Maschine anlegen, die der noch laufende Sweep der
 * Vorrunde dann als vermeintliche Waise mitlöscht. `#runEphemeralInfra`
 * ermittelt daher `status`/`patch` vollständig, OHNE zwischendurch `#finish`
 * aufzurufen, fährt danach den Sweep und ruft `#finish` erst am Ende genau
 * EINMAL. Ohne injizierte `vpsRegistry` degradiert der Sweep auf ein No-op
 * (kein Crash, best-effort — analog `dockerControl`).
 * Bekannte Grenze (dokumentiert, kein stiller Anspruch): der Sweep ist
 * GLOBAL über alle `rtest-*`-Maschinen dieses Servers — bei echter
 * Parallelität mehrerer Projekte mit je eigenen `ephemeral-infra`-Läufen
 * könnte ein Sweep eine fremde, noch laufende `rtest-*`-Maschine treffen;
 * heute existieren `ephemeral-infra`-Suiten nur in diesem Repo (kein
 * Parallelitäts-Fall in der Praxis). Ein Absturz des GESAMTEN dev-gui-
 * Serverprozesses (kein Timeout/Testfehler, sondern ein externer Kill) bleibt
 * strukturell unerreichbar für JEDEN In-Process-`finally` — das ist außerhalb
 * des Scopes dieses Runners (bräuchte eine separate Reconcile-Instanz).
 *
 * Vorbedingungen VOR `npx playwright test` — Test-Dependencies + Browser-
 * Versions-Guard (docs/specs/regression-local-execution.md AC1–AC3, `local`-
 * Pfad exklusiv, `ephemeral-infra` unberührt — Spec-Nicht-Ziel/Scope dieser
 * Story): fehlt `node_modules`/`@playwright/test` im Projekt-Klon (EIN Check,
 * `isPlaywrightTestInstalled`), führt `#ensureTestDependencies` `npm ci`
 * (Fallback `npm install`) im Klon-Root aus — idempotent (NFR), bereits
 * vorhandene Dependencies lösen KEINEN Install-Lauf aus. Danach prüft
 * `#checkBrowserVersionGuard`, ob die im Klon installierte `@playwright/test`-
 * Version zur Referenz-Version passt, gegen die das dev-gui-Image seine
 * Browser installiert hat (`/ms-playwright`, Dockerfile `npx playwright
 * install --with-deps chromium`) — Owner-Entscheidung A1: Browser fest im
 * Image, KEIN Laufzeit-Nachladen; die Referenz-Version ist die im
 * dev-gui-Image selbst installierte `@playwright/test`-Version
 * (`readImagePlaywrightVersion`, `createRequire`-Auflösung, robust gegen
 * `cwd`). Beide Prüfungen laufen NACH der Testobjekt-Weiche (nur `target:
 * local`) und VOR der lokalen Erreichbarkeitsprüfung/`npx playwright test` —
 * ein Fehlschlag endet als terminaler `error`/`precondition-error` mit
 * secret-freier, fester Diagnose (NIE roher Prozess-Output, [[regression-run]]
 * AC10) — NIE der unspezifische `NO_CTRF_MESSAGE`-Spätausfall für diese
 * Fehlerklasse (Befund 1).
 *
 * Port-Auflösung + deployment-bewusste Ziel-Adressierung
 * (docs/specs/regression-local-execution.md AC4–AC6, `local`-Pfad exklusiv,
 * `ephemeral-infra` unberührt — Spec-Nicht-Ziel/Scope dieser Story): die
 * `preview_port`/`container_port`-Leser (`readLocalPreviewPort`,
 * `readLocalRolloutConfig`) tolerieren einen Whitespace+Inline-Kommentar nach
 * der Zahl (AC4, Befund 2a). Findet der Runner nach der Testobjekt-Weiche
 * (nur `target: local`) KEINEN Port, endet der Lauf SOFORT als terminaler
 * `precondition-error` „lokaler Test-Port nicht bestimmbar" — statt
 * Frisch-Ausrollen/Erreichbarkeitsprüfung/`REGRESSION_BASE_URL` still zu
 * überspringen und Playwright base-url-los zu starten (AC5, Befund 2b). Die
 * lokale Erreichbarkeitsprüfung UND `REGRESSION_BASE_URL` nutzen danach
 * DIESELBE aufgelöste Adresse (`#resolveTargetAddress`, AC6): läuft dieser
 * Runner-Prozess selbst in einem Docker-Container (`isRunningInContainer`,
 * Standard-Indikator `/.dockerenv`), wird das Nachbar-Container-Testobjekt
 * über `host.docker.internal:<hostPort>` adressiert — `<hostPort>` NACH
 * MÖGLICHKEIT aus dem tatsächlichen Docker-Port-Mapping des Ziel-Containers
 * (`LocalDockerControl#getMappedHostPort`, dieselbe cicd/preview-Boundary wie
 * Frisch-Ausrollen AC7), NICHT aus dem Container-internen EXPOSE-Port
 * (Befund 3, `8080→8081`); ohne auflösbares `image`/`dockerControl`/Mapping
 * degradiert das best-effort auf den statisch gelesenen Port (kein Crash).
 * Im Host-Betrieb bleibt es unverändert bei `127.0.0.1:<port>`. Selbsttest
 * (`isSelfProject`, [[regression-run]] AC8) bleibt unberührt: bleibt IMMER
 * bei `127.0.0.1:<port>` (Playwright-Kindprozess + getesteter dev-gui-Server
 * teilen dieselbe Netzwerk-Namespace, direkter Loopback ohne Host-Umweg).
 *
 * App-Secret-Injektion (docs/specs/regression-local-execution.md AC7/AC8,
 * `local`-Pfad exklusiv — `ephemeral-infra` unberührt, Spec-Scope): NACH
 * erfolgreicher Erreichbarkeitsprüfung, VOR `npx playwright test`, löst
 * `resolveLocalRegressionSecrets()` die App-Secrets des Testobjekts auf und
 * injiziert sie AUSSCHLIESSLICH in die Kind-Env des Playwright-Prozesses
 * (`defaultRunPlaywright`s `secretEnv`-Parameter). Deklarativ (AC8): die
 * Menge der Secrets ist durch das PROJEKT-EIGENE, committete `.env.gpg`
 * bestimmt (Secrets-Subsystem, `docs/architecture/secrets-subsystem.md` §3 —
 * dieselbe Konvention wie die bestehende `run-regression.sh` „existiert
 * `scripts/load-env.sh`, wird geladen") — NICHT aus Test-/Datendateien der
 * Suite gelesen. Die per-App-GPG-Passphrase wird über die bestehende,
 * INJIZIERTE `BitwardenDeployLoginService`-Boundary abgerufen (Item
 * `env.gpg-passphrase-<projekt>`, `gpgItemNameFor()` — dieselbe Konvention
 * wie [[deploy-bitwarden-gpg-injection]] AC15, kein zweiter Bitwarden-Pfad).
 * Security-Floor (hart): die entschlüsselten Werte UND die Passphrase selbst
 * werden NIE geloggt/auditiert/über WS gesendet/als argv übergeben und NIE
 * auf Platte geschrieben — `.env.gpg` wird per `gpg -d` mit der Passphrase
 * über stdin entschlüsselt, das Klartext-Ergebnis existiert nur transient im
 * Prozess-Speicher (KEIN `.env`-Schreibzugriff, anders als `decrypt-env.sh`).
 * Best-effort/degradierend (A2 — kontrollierter Suite-`test.skip`, KEIN
 * Runner-Fehlzustand): ohne injizierten `deployLoginService`, ohne `.env.gpg`
 * im Klon, bei nicht abrufbarer Passphrase oder fehlgeschlagener
 * Entschlüsselung liefert die Funktion `{}` — der Playwright-Lauf startet
 * trotzdem; betroffene Testfälle skippen kontrolliert über ihr eigenes
 * `beforeAll` (Bestandsverhalten der Suite).
 *
 * @module RegressionRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ProjectJobLock } from './ProjectJobLock.js';
import { readRegressionSuites } from './RegressionSuiteReader.js';
import { gpgItemNameFor } from './PerAppGpgProvisioningService.js';

const _require = createRequire(import.meta.url);

/** Eigenständiger, entkoppelter Runaway-Timeout (Default 15 min — ein Playwright-Lauf kann mehrere Minuten dauern). */
export const DEFAULT_REGRESSION_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Timeout für die local-Erreichbarkeitsprüfung (ms). */
const REACHABILITY_TIMEOUT_MS = 3_000;

/** Relativer Pfad des Regressions-Testbaums im Projekt-Klon (agent-flow `regression-playwright-conventions` AC2). */
export const REGRESSION_TESTS_ROOT = 'tests/regression';

/** Relativer Pfad des CTRF-JSON-Ergebnisses (Referenz-Template `outputDir: 'test-results'`, Default-Dateiname des Reporters). */
export const CTRF_RESULT_PATH = 'test-results/ctrf-report.json';

/**
 * Selbsttest-Erkennung (AC8, Annahme A2 der Spec): Projekt-Slug, unter dem
 * dieser Runner-Prozess selbst läuft (`package.json` `name`, s. `.claude/profile.md`
 * dieses Repos). Ist das Testobjekt DIESER Slug, wird Frisch-Ausrollen
 * server-seitig hart übersprungen (ein recreate würde den eigenen Prozess
 * mitsamt Lauf beenden).
 */
export const SELF_PROJECT_SLUG = 'dev-gui';

// ── Secret-freie Meldungstexte ────────────────────────────────────────────────
const PRECONDITION_MESSAGE = 'Applikation lokal nicht gestartet';
const NO_SCAFFOLD_MESSAGE = 'kein Regressions-Grundgerüst';
const GENERIC_FAILURE_MESSAGE = 'Regressionslauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Regressionslauf abgebrochen (Timeout)';
const NOT_AVAILABLE_MESSAGE = 'npx nicht verfügbar';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Regressions-Runner';
const NO_CTRF_MESSAGE = 'Regressionslauf beendet, aber kein CTRF-Ergebnis gefunden';
const ROLLOUT_FAILURE_MESSAGE = 'Frisch-Ausrollen fehlgeschlagen';
const ROLLOUT_NOT_READY_MESSAGE = 'Applikation lokal nicht gestartet';
const DEPENDENCY_INSTALL_FAILURE_MESSAGE = 'Test-Dependencies konnten nicht installiert werden';
const BROWSER_VERSION_MISMATCH_MESSAGE = 'Playwright-Version des Projekts passt nicht zum Image-Browser';
const PORT_NOT_RESOLVABLE_MESSAGE = 'lokaler Test-Port nicht bestimmbar';

/** Standard-Indikator, den Docker in JEDEM Container automatisch anlegt (AC6) — kein neuer Env-/Config-Vertrag. */
const DOCKERENV_PATH = '/.dockerenv';

/** Hostname, über den ein Docker-Container den Host erreicht (AC6, A4). */
const DOCKER_HOST_GATEWAY = 'host.docker.internal';

/** Relativer Pfad des `@playwright/test`-`package.json` im Projekt-Klon (AC1/AC2). */
const PLAYWRIGHT_TEST_PACKAGE_JSON = 'node_modules/@playwright/test/package.json';

/** Verschlüsselte App-Secrets-Datei im Projekt-Klon (Secrets-Subsystem, AC7/AC8). */
const ENV_GPG_FILENAME = '.env.gpg';

/** `gpg -d`-Argv für die App-Secret-Entschlüsselung (AC7) — Passphrase NUR via stdin (`--passphrase-fd 0`), NIE argv. */
const GPG_DECRYPT_ARGS = ['--batch', '--quiet', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '-d', ENV_GPG_FILENAME];

/**
 * Bekannte, bereits im Testobjekt-Modell definierte, aber (noch) nicht
 * gebaute `target`-Werte (AC11, A4 — `ephemeral-infra`/A3 hat seit AC12/S-362
 * einen eigenen Ausführungspfad, `#runEphemeralInfra`, und läuft daher NICHT
 * mehr über diesen Zweig) — dürfen wörtlich in die Fehlermeldung übernommen
 * werden (Datenhygiene: nur bekannte Werte).
 */
const KNOWN_UNSUPPORTED_TARGETS = new Set(['url']);

/** Namensschema-Präfix für flüchtige Test-Ressourcen (AC7, agent-flow `regression-runner` AC7). */
const RTEST_PREFIX = 'rtest-';

/**
 * Baut die secret-freie „noch nicht unterstützt"-Meldung für ein deklariertes,
 * aber (noch) nicht gebautes Testobjekt (AC11 — `ephemeral-infra` hat seit
 * AC12/S-362 einen eigenen Ausführungspfad und landet hier nicht mehr).
 * `target` kommt aus einer Repo-Datei, die dieser Runner nicht kontrolliert —
 * nur die bekannten Werte (aktuell: `url`) werden wörtlich übernommen; ein
 * unbekannter/unerwarteter Wert erzeugt eine generische Meldung (keine
 * Übernahme beliebiger Fremd-Strings in die Diagnose).
 *
 * @param {string} target
 * @returns {string}
 */
export function buildUnsupportedTargetMessage(target) {
  if (KNOWN_UNSUPPORTED_TARGETS.has(target)) {
    return `Testobjekt ${target} wird noch nicht unterstützt`;
  }
  return 'Testobjekt wird noch nicht unterstützt';
}

/**
 * Validiert den Ausführen-Scope (Vertrag `regression-run.md` §Verträge).
 * Reine Funktion, vom Router UND vom Runner autoritativ genutzt (Defense in Depth).
 *
 * @param {unknown} scope
 * @returns {{ ok: true, scope: { typ: 'bereich'|'verbund'|'gesamt', id?: string } } | { ok: false, reason: string }}
 */
export function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    return { ok: false, reason: 'invalid' };
  }
  if (scope.typ !== 'bereich' && scope.typ !== 'verbund' && scope.typ !== 'gesamt') {
    return { ok: false, reason: 'invalid-typ' };
  }
  if (scope.typ === 'gesamt') {
    return { ok: true, scope: { typ: 'gesamt' } };
  }
  const id = typeof scope.id === 'string' ? scope.id.trim() : '';
  if (scope.typ === 'verbund') {
    // AC13: `id` ist für `verbund` optional — scopeToTestPath/#resolveTarget
    // ignorieren sie ohnehin. Ein mitgesendetes `id` ist tolerant, aber
    // wirkungslos (kein eigener Unter-Namensordner je Verbund-Name).
    return id === '' ? { ok: true, scope: { typ: 'verbund' } } : { ok: true, scope: { typ: 'verbund', id } };
  }
  if (id === '') {
    return { ok: false, reason: 'missing-id' };
  }
  return { ok: true, scope: { typ: scope.typ, id } };
}

/**
 * Baut den relativen Playwright-Test-Pfad für einen validierten Scope (agent-flow
 * `regression-playwright-conventions` AC2 Layout). `verbund` hat KEINEN eigenen
 * Unter-Namensordner je Verbund-Name — alle Verbund-Suiten liegen gemeinsam
 * unter `tests/regression/verbund` (Layout-Vertrag; s. Modul-Doku SPEC-LÜCKE-Hinweis).
 *
 * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
 * @returns {string} relativer Pfad ab dem Projekt-Root.
 */
export function scopeToTestPath(scope) {
  if (scope.typ === 'bereich') return `${REGRESSION_TESTS_ROOT}/${scope.id}`;
  if (scope.typ === 'verbund') return `${REGRESSION_TESTS_ROOT}/verbund`;
  return REGRESSION_TESTS_ROOT;
}

/**
 * Regex-Fragment für einen `<key>: <digits>`-Wert, der einen optionalen
 * Whitespace+Inline-Kommentar nach der Zahl toleriert (regression-local-
 * execution AC4, Befund 2a — z.B. `container_port: 8080    # EXPOSE aus dem
 * Dockerfile`). `[ \t]*` statt `\s*` NACH der Zahl, damit kein Zeilenumbruch
 * versehentlich mit verschluckt wird; `$` im multiline-Modus matcht das
 * Zeilenende.
 *
 * @param {string} key
 * @returns {RegExp}
 */
function portFieldRegex(key) {
  return new RegExp(`^${key}:\\s*(\\d+)[ \\t]*(?:#.*)?$`, 'm');
}

/**
 * Liest `preview_port` (Fallback: `container_port`) aus `.claude/profile.md`
 * des Projekt-Klons (Muster `templates/_shared/regression/run-regression.sh`).
 * Liefert `null`, wenn die Datei fehlt oder kein Port auffindbar ist (kein Crash).
 * Toleriert einen Whitespace+Inline-Kommentar nach der Zahl (AC4).
 *
 * @param {string} projectPath - absoluter, validierter Projekt-Pfad.
 * @param {{ readFile?: Function }} [deps] - injectable fs-Dep für Tests.
 * @returns {Promise<number|null>}
 */
export async function readLocalPreviewPort(projectPath, { readFile: readFileFn = readFile } = {}) {
  let content;
  try {
    content = await readFileFn(join(projectPath, '.claude/profile.md'), 'utf8');
  } catch {
    return null;
  }
  const previewMatch = content.match(portFieldRegex('preview_port'));
  if (previewMatch) return Number(previewMatch[1]);
  const containerMatch = content.match(portFieldRegex('container_port'));
  if (containerMatch) return Number(containerMatch[1]);
  return null;
}

/**
 * Liest `image` + `container_port` aus `.claude/profile.md` des Projekt-Klons
 * (agent-flow `/preview up`-Konvention, s. Modul-Doku AC7) — für das
 * Frisch-Ausrollen (`pullAndRecreate`) UND die deployment-bewusste Ziel-
 * Adressierung (AC6). Liefert `null`, wenn `image` fehlt (kein Crash —
 * Frisch-Ausrollen wird dann übersprungen). Toleriert einen Whitespace+
 * Inline-Kommentar nach `container_port` (AC4).
 *
 * @param {string} projectPath - absoluter, validierter Projekt-Pfad.
 * @param {{ readFile?: Function }} [deps] - injectable fs-Dep für Tests.
 * @returns {Promise<{ image: string, containerPort: number } | null>}
 */
export async function readLocalRolloutConfig(projectPath, { readFile: readFileFn = readFile } = {}) {
  let content;
  try {
    content = await readFileFn(join(projectPath, '.claude/profile.md'), 'utf8');
  } catch {
    return null;
  }
  const imageMatch = content.match(/^image:\s*(\S+)\s*$/m);
  if (!imageMatch) return null;
  const containerMatch = content.match(portFieldRegex('container_port'));
  return {
    image: imageMatch[1],
    containerPort: containerMatch ? Number(containerMatch[1]) : null,
  };
}

/**
 * Erkennt, ob DIESER Runner-Prozess selbst in einem Docker-Container läuft
 * (regression-local-execution AC6 — Deployment-bewusste Ziel-Adressierung).
 * Standard-Indikator `/.dockerenv` (von Docker selbst in JEDEM Container
 * angelegt, kein neuer Env-/Config-Vertrag). Best-effort: ein Lesefehler
 * zählt konservativ als "nicht im Container" (degradiert auf den bisherigen
 * `127.0.0.1`-Pfad statt einen potenziell unerreichbaren Hostnamen zu
 * erzwingen).
 *
 * @param {{ existsSync?: Function }} [deps] - injectable für Tests.
 * @returns {boolean}
 */
export function isRunningInContainer({ existsSync: existsSyncFn = existsSync } = {}) {
  try {
    return existsSyncFn(DOCKERENV_PATH);
  } catch {
    return false;
  }
}

/**
 * Selbsttest-Erkennung (AC8, Annahme A2): ist das Testobjekt-Projekt
 * (`projekt`-Slug) DIESER Runner-Prozess selbst?
 *
 * @param {string} projekt - Projekt-Slug (s. `start()`).
 * @returns {boolean}
 */
export function isSelfProject(projekt) {
  return projekt === SELF_PROJECT_SLUG;
}

/**
 * Leitet den Docker-Container-Namen aus einer Image-Referenz ab — exakt die
 * agent-flow `/preview up`-Konvention (`skills/preview/SKILL.md` Abschnitt
 * „Variablen": `app` ← letztes Segment der Image-Referenz, **kleingeschrieben**
 * `tr 'A-Z' 'a-z'`; GitHub erlaubt Großbuchstaben im Repo-Namen, Docker NICHT
 * — Beispiel `Spoon-Knife → spoon-knife`). MUSS für `pullAndRecreate()`
 * verwendet werden statt des rohen, case-erhaltenden `projekt`-Slugs — sonst
 * trifft `docker rm -f` keinen existierenden Preview-Container (No-Op) und
 * `docker run --name` legt einen zweiten, parallelen Container an.
 *
 * @param {string} image - z.B. `ghcr.io/studis-softwareschmiede/Sandbox-2`.
 * @returns {string} letztes `/`-Segment, lowercase — z.B. `sandbox-2`.
 */
export function deriveContainerNameFromImage(image) {
  const lastSegment = String(image).split('/').pop();
  return lastSegment.toLowerCase();
}

/**
 * Best-effort HTTP-Erreichbarkeitsprüfung gegen `http://<address>/` (Muster
 * `LocalDockerControl#probeReachability`). `address` ist die bereits
 * deployment-bewusst aufgelöste `host:port`-Adresse (AC6 — DIESELBE, die auch
 * für `REGRESSION_BASE_URL` verwendet wird, s. `#resolveTargetAddress`).
 * Jeder HTTP-Statuscode zählt als erreichbar; Timeout/Refused → false.
 *
 * @param {string} address - z.B. `127.0.0.1:8080` oder `host.docker.internal:8081`.
 * @param {{ fetchFn?: Function }} [deps] - injectable fetch für Tests.
 * @returns {Promise<boolean>}
 */
export async function probeLocalReachability(address, { fetchFn } = {}) {
  const _fetch = fetchFn ?? defaultFetchProbe;
  try {
    return await _fetch(`http://${address}/`, REACHABILITY_TIMEOUT_MS);
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function defaultFetchProbe(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(url, { signal: controller.signal });
    return true; // jeder Statuscode gilt als erreichbar (AC5)
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liest + parst das CTRF-JSON-Ergebnis aus dem Projekt-Klon. Liefert `null`
 * bei fehlender/korrupter Datei (kein Crash — der Aufrufer mappt das auf
 * einen definierten Fehlerzustand).
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function }} [deps]
 * @returns {Promise<object|null>}
 */
export async function readCtrfResult(projectPath, { readFile: readFileFn = readFile } = {}) {
  try {
    const raw = await readFileFn(join(projectPath, CTRF_RESULT_PATH), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extrahiert `{passed,failed,total}` + Gesamt-Status aus einem CTRF-JSON-Objekt
 * (`results.summary.{tests,passed,failed}`, CTRF-Standardschema). Tolerant
 * gegenüber fehlenden Feldern (defensiv, kein Crash bei abweichendem Schema).
 *
 * @param {object|null} ctrf
 * @returns {{ counts: { passed: number, failed: number, total: number }, status: 'passed'|'failed' }}
 */
export function summarizeCtrf(ctrf) {
  const summary = ctrf?.results?.summary ?? {};
  const passed = Number.isFinite(summary.passed) ? summary.passed : 0;
  const failed = Number.isFinite(summary.failed) ? summary.failed : 0;
  const total = Number.isFinite(summary.tests) ? summary.tests : passed + failed;
  return {
    counts: { passed, failed, total },
    status: failed > 0 ? 'failed' : 'passed',
  };
}

/**
 * Default `npx playwright test`-Adapter (AC1/AC9): startet den Kindprozess als
 * Array-argv (kein Shell-String, security/R03), `cwd` = Projekt-Pfad. KEIN
 * `claude`, KEIN API-Key, KEINE HeadlessRunnerCore-Env-Übernahme nötig — die
 * Kind-Env ist die volle Prozess-Env (Playwright/Node brauchen z.B. `PATH`,
 * `HOME`) plus die App-Secrets aus `secretEnv` (regression-local-execution
 * AC7/AC8, `resolveLocalRegressionSecrets()` — deklarativ aus dem projekt-
 * eigenen `.env.gpg`, nie aus Test-/Datendateien der Suite gelesen; dieser
 * Runner persistiert nichts davon).
 *
 * @param {object} params
 * @param {string} params.projectPath
 * @param {string} params.testPath - relativer Pfad (Verzeichnis/Datei) an `npx playwright test`.
 * @param {string} [params.baseUrl] - REGRESSION_BASE_URL (nur bei `local`, Playwright-Config-Konvention).
 * @param {Record<string,string>} [params.secretEnv] - App-Secrets (regression-local-execution AC7/AC8),
 *   NUR in die Kind-Env gemischt — NIE geloggt/in argv (`resolveLocalRegressionSecrets()`, Default: `{}`).
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn] - injectable (default node:child_process spawn).
 * @returns {Promise<{ exitCode: number|null, spawnError?: boolean, timedOut?: boolean }>}
 */
export function defaultRunPlaywright({
  projectPath,
  testPath,
  baseUrl,
  secretEnv,
  timeoutMs = DEFAULT_REGRESSION_RUN_TIMEOUT_MS,
  spawnFn = nodeSpawn,
}) {
  return new Promise((resolve) => {
    const argv = ['playwright', 'test', testPath];

    let settled = false;
    let timeoutHandle;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    // AC7: App-Secrets NUR in die Kind-Env gemischt — nie in argv, nie geloggt
    // (stdout/stderr des Kindprozesses werden weiter unten nur gedraint, nie
    // ausgewertet/geloggt — s. bestehende Kommentare).
    const env = { ...process.env, ...(secretEnv || {}) };
    if (baseUrl) env.REGRESSION_BASE_URL = baseUrl;

    try {
      child = spawnFn('npx', argv, {
        cwd: projectPath,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish({ exitCode: -1, spawnError: true });
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish({ exitCode: -1, timedOut: true });
    }, timeoutMs);

    // stdout/stderr draining (keine Pipe-Blockade) — Inhalt wird nicht
    // ausgewertet, das Ergebnis kommt aus dem CTRF-JSON (readCtrfResult).
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    child.on('close', (code) => {
      finish({ exitCode: code });
    });

    child.on('error', (err) => {
      finish({ exitCode: -1, spawnError: true, notFound: err?.code === 'ENOENT' });
    });
  });
}

/**
 * Prüft, ob `@playwright/test` im Projekt-Klon installiert ist
 * (docs/specs/regression-local-execution.md AC1). Existenz von
 * `node_modules/@playwright/test/package.json` deckt in EINEM Check sowohl
 * "node_modules fehlt komplett" als auch "nur @playwright/test fehlt" ab.
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function }} [deps] - injectable fs-Dep für Tests.
 * @returns {Promise<boolean>}
 */
export async function isPlaywrightTestInstalled(projectPath, { readFile: readFileFn = readFile } = {}) {
  try {
    await readFileFn(join(projectPath, PLAYWRIGHT_TEST_PACKAGE_JSON), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Default `npm <args>`-Adapter (AC1): startet den Kindprozess als Array-argv
 * (kein Shell-String, security/R03), `cwd` = Projekt-Pfad. Eigener,
 * entkoppelter Timeout (Default: derselbe Runaway-Timeout-Wert wie der
 * Playwright-Lauf, Wiederverwendung statt neuer Konstante) — verhindert einen
 * hängenden `npm ci` bei Netzfehlern.
 *
 * @param {object} params
 * @param {string} params.projectPath
 * @param {string[]} params.args - z.B. `['ci']` oder `['install']`.
 * @param {number} [params.timeoutMs]
 * @param {Function} [params.spawnFn] - injectable (default node:child_process spawn).
 * @returns {Promise<{ exitCode: number|null, spawnError?: boolean, timedOut?: boolean }>}
 */
export function defaultRunNpmCommand({ projectPath, args, timeoutMs = DEFAULT_REGRESSION_RUN_TIMEOUT_MS, spawnFn = nodeSpawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    try {
      child = spawnFn('npm', args, { cwd: projectPath, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ exitCode: null, spawnError: true });
      return;
    }

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);

    // stdout/stderr draining (keine Pipe-Blockade) — Inhalt wird NICHT in die
    // Diagnose übernommen (Secret-Floor: kein roher Prozess-Output, AC1).
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});

    child.on('close', (code) => finish({ exitCode: code }));
    child.on('error', () => finish({ exitCode: null, spawnError: true }));
  });
}

/**
 * Stellt die Test-Dependencies im Projekt-Klon her (AC1): fehlt
 * `node_modules` ODER `@playwright/test`, führt diese Funktion `npm ci`
 * (Fallback `npm install`) im Klon-Root aus, BEVOR der Test startet.
 * Idempotent (NFR) — bereits vorhandene Dependencies lösen KEINEN Install-Lauf
 * aus. Schlägt auch der Fallback fehl (oder ist `@playwright/test` danach
 * immer noch nicht auffindbar), liefert die Funktion einen secret-freien,
 * festen Fehlgrund (AC1, [[regression-run]] AC10) — NIE roher Prozess-Output.
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function, runNpmCommand?: Function }} [deps] - injectable für Tests.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function ensureTestDependencies(
  projectPath,
  { readFile: readFileFn = readFile, runNpmCommand = defaultRunNpmCommand } = {},
) {
  const alreadyInstalled = await isPlaywrightTestInstalled(projectPath, { readFile: readFileFn });
  if (alreadyInstalled) return { ok: true };

  let result = await runNpmCommand({ projectPath, args: ['ci'] });
  if (result?.exitCode !== 0) {
    result = await runNpmCommand({ projectPath, args: ['install'] });
  }
  if (result?.exitCode !== 0) {
    return { ok: false, reason: DEPENDENCY_INSTALL_FAILURE_MESSAGE };
  }

  const installedNow = await isPlaywrightTestInstalled(projectPath, { readFile: readFileFn });
  if (!installedNow) {
    return { ok: false, reason: DEPENDENCY_INSTALL_FAILURE_MESSAGE };
  }
  return { ok: true };
}

/**
 * Liest die im Projekt-Klon installierte `@playwright/test`-Version aus
 * `node_modules/@playwright/test/package.json` (AC2). `null` wenn nicht
 * auffindbar/unlesbar/kein `version`-Feld (kein Crash — der Aufrufer
 * behandelt das als "Guard nicht bestehbar").
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function }} [deps]
 * @returns {Promise<string|null>}
 */
export async function readInstalledPlaywrightVersion(projectPath, { readFile: readFileFn = readFile } = {}) {
  try {
    const raw = await readFileFn(join(projectPath, PLAYWRIGHT_TEST_PACKAGE_JSON), 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Löst den absoluten Pfad des dev-gui-eigenen (Image-)
 * `@playwright/test/package.json` auf — über `createRequire`, robust gegen
 * `cwd` (funktioniert unabhängig vom Arbeitsverzeichnis des Prozesses).
 *
 * @returns {string}
 */
export function resolveImagePlaywrightTestPackageJson() {
  return _require.resolve('@playwright/test/package.json');
}

/**
 * Liest die REFERENZ-Playwright-Version — die im dev-gui-Image selbst
 * installierte `@playwright/test`-Version (AC2, A1: die Browser unter
 * `/ms-playwright` wurden beim Image-Build GENAU gegen diese Version
 * installiert, `Dockerfile` `npx playwright install --with-deps chromium`).
 *
 * @param {{ resolvePackageJson?: Function, readFile?: Function }} [deps] - injectable für Tests.
 * @returns {Promise<string|null>}
 */
export async function readImagePlaywrightVersion({
  resolvePackageJson = resolveImagePlaywrightTestPackageJson,
  readFile: readFileFn = readFile,
} = {}) {
  try {
    const pkgPath = resolvePackageJson();
    const raw = await readFileFn(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Browser-Versions-Guard (AC2, Owner-Entscheidung A1 — Browser fest im Image,
 * KEIN Laufzeit-Nachladen): prüft, dass die im Klon installierte
 * `@playwright/test`-Version EXAKT zur Referenz-Version passt, gegen die das
 * dev-gui-Image seine Browser installiert hat. A1-Konvention: agent-flow-
 * Template + Projekt-Repos pinnen dieselbe Version wie das Image — im
 * Normalbetrieb schlägt dieser Guard daher nie an. Exakter String-Vergleich
 * (beide Seiten sind konkrete, aufgelöste Versionen — keine Semver-Ranges).
 * Nicht auflösbar (Klon-Version ODER Referenz-Version fehlt) zählt konservativ
 * als Mismatch — KEIN blinder Playwright-Start ohne diese Garantie (AC2/AC3).
 *
 * @param {string} projectPath
 * @param {{ readFile?: Function, readImageVersion?: Function }} [deps] - injectable für Tests.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function checkBrowserVersionGuard(
  projectPath,
  { readFile: readFileFn = readFile, readImageVersion = readImagePlaywrightVersion } = {},
) {
  const [cloneVersion, imageVersion] = await Promise.all([
    readInstalledPlaywrightVersion(projectPath, { readFile: readFileFn }),
    readImageVersion({ readFile: readFileFn }),
  ]);
  if (!cloneVersion || !imageVersion || cloneVersion !== imageVersion) {
    return { ok: false, reason: BROWSER_VERSION_MISMATCH_MESSAGE };
  }
  return { ok: true };
}

/**
 * Entschlüsselt `.env.gpg` im Projekt-Klon per `gpg -d` (AC7) — die Passphrase
 * geht AUSSCHLIESSLICH über stdin (`--passphrase-fd 0`, NIE argv/env-Var), das
 * entschlüsselte Ergebnis wird NUR aus stdout gelesen (NIE auf Platte
 * geschrieben — anders als das per-App `decrypt-env.sh`, das bewusst
 * `.env`-freie Muster von `load-env.sh` wird hier 1:1 nachgebildet). stderr
 * wird verworfen (könnte gpg-Diagnosetext enthalten, wird aber nie benötigt
 * und NIE geloggt — Security-Floor).
 *
 * @param {string} projectPath - absoluter Projekt-Klon-Pfad (cwd für `gpg`, `.env.gpg` muss dort liegen).
 * @param {string} passphrase - App-eigene GPG-Passphrase (Klartext, nur transient im Prozess).
 * @param {{ spawnFn?: Function }} [deps] - injectable (default node:child_process spawn).
 * @returns {Promise<{ ok: true, content: string } | { ok: false }>}
 */
export function defaultDecryptEnvGpg(projectPath, passphrase, { spawnFn = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('gpg', GPG_DECRYPT_ARGS, { cwd: projectPath, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false });
      return;
    }

    let stdout = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', () => {}); // verworfen, nie geloggt (Security-Floor)

    child.on('close', (code) => finish(code === 0 ? { ok: true, content: stdout } : { ok: false }));
    child.on('error', () => finish({ ok: false }));

    child.stdin?.write(passphrase);
    child.stdin?.end();
  });
}

/**
 * Parst ein `.env`-formatiertes Klartext-Dokument (`KEY=VALUE`-Zeilen, optionales
 * `export `-Präfix, `#`-Kommentare/Leerzeilen übersprungen, optionale umschließende
 * Anführungszeichen entfernt) — dieselbe simple Konvention wie `.env.example`/
 * `templates/_shared/secrets/.env.example` (AC7/AC8, keine Shell-`eval`-Auswertung,
 * bewusst restriktiver als `load-env.sh` — kein Ausführungsrisiko für den
 * entschlüsselten Inhalt).
 *
 * @param {string} content
 * @returns {Record<string,string>}
 */
export function parseDotenvContent(content) {
  const result = {};
  for (const rawLine of String(content ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

/**
 * Löst die App-Secrets für die Playwright-Kind-Env auf (regression-local-execution
 * AC7/AC8, `local`-Pfad exklusiv) — s. Modul-Doku für die vollständige Begründung.
 * Deklarativ (AC8): die Menge der Secrets ist durch das PROJEKT-EIGENE `.env.gpg`
 * bestimmt, NICHT aus Test-/Datendateien der Suite gelesen. Die per-App-
 * GPG-Passphrase kommt über die injizierte `BitwardenDeployLoginService`-Boundary
 * (Item `env.gpg-passphrase-<projekt>`, `gpgItemNameFor()` — AC15-Konvention).
 *
 * Best-effort/degradierend (A2 — kontrollierter Suite-`test.skip`, KEIN
 * Runner-Fehlzustand): liefert `{}`, wenn (a) kein `deployLoginService`
 * injiziert ist, (b) `.env.gpg` im Klon fehlt, (c) die Passphrase nicht
 * abrufbar ist (Zugang unvollständig/Item nicht gefunden/bw unerreichbar)
 * oder (d) die Entschlüsselung fehlschlägt — der Playwright-Lauf startet in
 * JEDEM dieser Fälle trotzdem (kein `precondition-error`/`error`). Diagnose-
 * Ausgaben (console.error) sind IMMER secret-frei (nur die Fehlerklasse, NIE
 * die Passphrase/entschlüsselte Werte).
 *
 * @param {string} projectPath
 * @param {string} projekt - Ziel-Slug (Bitwarden-Item-Namens-Konvention, AC15).
 * @param {object} [deps]
 * @param {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService|null} [deps.deployLoginService] - injectable (ohne → degradiert, kein Crash).
 * @param {Function} [deps.readFile] - injectable (Existenz-Check `.env.gpg`, default node:fs/promises readFile).
 * @param {Function} [deps.decryptEnvGpg] - injectable (default: defaultDecryptEnvGpg).
 * @param {string|null} [deps.identity] - für den Bitwarden-Fetch-Audit (`fetchItemPassword`).
 * @returns {Promise<Record<string,string>>}
 */
export async function resolveLocalRegressionSecrets(
  projectPath,
  projekt,
  { deployLoginService = null, readFile: readFileFn = readFile, decryptEnvGpg = defaultDecryptEnvGpg, identity = null } = {},
) {
  if (!deployLoginService || typeof deployLoginService.fetchItemPassword !== 'function') {
    return {}; // kein Zugang injiziert -> best-effort übersprungen (A2, kein Crash)
  }

  try {
    await readFileFn(join(projectPath, ENV_GPG_FILENAME), 'utf8');
  } catch {
    return {}; // kein .env.gpg im Klon -> Projekt deklariert keine App-Secrets (A2)
  }

  let passphrase;
  try {
    passphrase = await deployLoginService.fetchItemPassword(gpgItemNameFor(projekt), { identity });
  } catch (err) {
    // A2: Abruf-Fehler (access-incomplete/item-not-found/bw-unreachable/…) ->
    // kontrollierter Skip, KEIN Runner-Fehlzustand. Secret-freie Diagnose (nur
    // die Fehlerklasse, nie Rohtext/Werte).
    console.error(
      '[RegressionRunner] App-Secrets: Bitwarden-Abruf fehlgeschlagen (best-effort, kontrollierter Skip):',
      err?.deployErrorClass ?? 'error',
    );
    return {};
  }

  const outcome = await decryptEnvGpg(projectPath, passphrase, {});
  if (!outcome?.ok) {
    console.error('[RegressionRunner] App-Secrets: .env.gpg-Entschlüsselung fehlgeschlagen (best-effort, kontrollierter Skip)');
    return {};
  }
  return parseDotenvContent(outcome.content);
}

/**
 * RegressionRunner — deterministischer `npx playwright test`-Runner + In-Memory
 * Job-Registry (docs/specs/regression-run.md AC1, AC2, AC3, AC5, AC9;
 * docs/specs/regression-local-execution.md AC1–AC8).
 */
export class RegressionRunner {
  /** @type {(params: object) => Promise<object>} */
  #runPlaywright;
  /** @type {ProjectJobLock} */
  #lock;
  /** @type {number} */
  #timeoutMs;
  /** @type {import('./AuditStore.js').AuditStore|null} */
  #auditStore;
  /** @type {import('./RegressionResultStore.js').RegressionResultStore|null} */
  #resultStore;
  /** @type {(projectPath: string, deps?: object) => Promise<number|null>} */
  #readPort;
  /** @type {(address: string, deps?: object) => Promise<boolean>} */
  #probeReachability;
  /** @type {(projectPath: string, deps?: object) => Promise<object|null>} */
  #readCtrf;
  /** @type {Function} injectable readFile (fürs "kein Grundgerüst"-Vorprüfen) */
  #readFile;
  /** @type {(projectPath: string, deps?: object) => Promise<{image:string,containerPort:number|null}|null>} */
  #readRolloutConfig;
  /** @type {import('./deploy/LocalDockerControl.js').LocalDockerControl|null} injectable (AC7, Default: kein Frisch-Ausrollen) */
  #dockerControl;
  /** @type {import('./DrainNotifier.js').DrainNotifier|null} injectable (regression-failed-notification AC1–AC4, Default: kein Push) */
  #notifier;
  /** @type {(projectPath: string, deps?: object) => Promise<{suites: Array<object>}>} injectable (AC11 — dieselbe Lese-Boundary wie der Ausführen-Dialog, Default: readRegressionSuites) */
  #readSuites;
  /** @type {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry|null} injectable (AC12 — Sicherheitsnetz-Sweep für `rtest-*`-Ressourcen, Default: kein Sweep möglich, degradiert) */
  #vpsRegistry;
  /** @type {(projectPath: string, deps?: object) => Promise<{ok:true}|{ok:false,reason:string}>} injectable (regression-local-execution AC1, Default: ensureTestDependencies) */
  #ensureTestDependencies;
  /** @type {(projectPath: string, deps?: object) => Promise<{ok:true}|{ok:false,reason:string}>} injectable (regression-local-execution AC2, Default: checkBrowserVersionGuard) */
  #checkBrowserVersionGuard;
  /** @type {() => boolean} injectable (regression-local-execution AC6, Default: isRunningInContainer — `/.dockerenv`-Indikator) */
  #isContainerDeployment;
  /** @type {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService|null} injectable (regression-local-execution AC7/AC8, Default: keine Secret-Injektion möglich, degradiert) */
  #deployLoginService;
  /** @type {(projectPath: string, passphrase: string, deps?: object) => Promise<{ok:true,content:string}|{ok:false}>} injectable (regression-local-execution AC7, Default: defaultDecryptEnvGpg) */
  #decryptEnvGpg;
  /**
   * @type {Map<string, {
   *   status: 'running'|'passed'|'failed'|'precondition-error'|'error',
   *   target?: string, suite: string, scopeTyp: string,
   *   counts?: { passed: number, failed: number, total: number },
   *   durationMs?: number, reason?: string,
   *   projectPath: string, projekt: string, identity: string|null,
   *   freshRollout: boolean,
   * }>}
   */
  #jobs = new Map();

  /**
   * @param {object} [params]
   * @param {Function} [params.runPlaywright] - injectable Adapter (default: defaultRunPlaywright).
   * @param {ProjectJobLock} [params.lock] - injectable Lock (default: EIGENE, isolierte Instanz).
   * @param {number} [params.timeoutMs] - default: env REGRESSION_RUN_TIMEOUT_MS oder Default.
   * @param {import('./AuditStore.js').AuditStore} [params.auditStore] - optional (Ende/Fehler-Audit).
   * @param {import('./RegressionResultStore.js').RegressionResultStore} [params.resultStore] - optional (AC9).
   * @param {Function} [params.spawnFn] - nur wirksam wenn `runPlaywright` NICHT übergeben wird.
   * @param {Function} [params.readPort] - injectable (default: readLocalPreviewPort).
   * @param {Function} [params.probeReachability] - injectable (default: probeLocalReachability).
   * @param {Function} [params.readCtrf] - injectable (default: readCtrfResult).
   * @param {Function} [params.readFile] - injectable fs.readFile (Grundgerüst-Vorprüfung).
   * @param {Function} [params.readRolloutConfig] - injectable (default: readLocalRolloutConfig, AC7).
   * @param {import('./deploy/LocalDockerControl.js').LocalDockerControl} [params.dockerControl] - injectable (AC7; ohne → kein Frisch-Ausrollen möglich, degradiert).
   * @param {import('./DrainNotifier.js').DrainNotifier} [params.notifier] - injectable (regression-failed-notification AC1–AC4; ohne → kein Push, degradiert).
   * @param {Function} [params.readSuites] - injectable (AC11, default: readRegressionSuites — dieselbe Lese-Boundary wie der Ausführen-Dialog, AC4/AC6).
   * @param {import('./vps/VpsProviderRegistry.js').VpsProviderRegistry} [params.vpsRegistry] - injectable (AC12; ohne → Sicherheitsnetz-Sweep degradiert auf No-op, kein Crash).
   * @param {Function} [params.ensureTestDependencies] - injectable (regression-local-execution AC1, default: ensureTestDependencies).
   * @param {Function} [params.checkBrowserVersionGuard] - injectable (regression-local-execution AC2, default: checkBrowserVersionGuard).
   * @param {Function} [params.isContainerDeployment] - injectable (regression-local-execution AC6, default: isRunningInContainer).
   * @param {import('./BitwardenDeployLoginService.js').BitwardenDeployLoginService} [params.deployLoginService] - injectable (regression-local-execution AC7/AC8; ohne → keine Secret-Injektion, degradiert).
   * @param {Function} [params.decryptEnvGpg] - injectable (regression-local-execution AC7, default: defaultDecryptEnvGpg).
   */
  constructor({
    runPlaywright,
    lock,
    timeoutMs,
    auditStore,
    resultStore,
    spawnFn,
    readPort,
    probeReachability,
    readCtrf,
    readFile: readFileFn,
    readRolloutConfig,
    dockerControl,
    notifier,
    readSuites,
    vpsRegistry,
    ensureTestDependencies: ensureTestDependenciesFn,
    checkBrowserVersionGuard: checkBrowserVersionGuardFn,
    isContainerDeployment,
    deployLoginService,
    decryptEnvGpg,
  } = {}) {
    this.#timeoutMs = timeoutMs ?? (Number(process.env.REGRESSION_RUN_TIMEOUT_MS) || DEFAULT_REGRESSION_RUN_TIMEOUT_MS);
    this.#readRolloutConfig = readRolloutConfig ?? readLocalRolloutConfig;
    this.#dockerControl = dockerControl ?? null;
    this.#runPlaywright =
      runPlaywright ?? ((params) => defaultRunPlaywright({ ...params, timeoutMs: this.#timeoutMs, spawnFn }));
    this.#lock = lock ?? new ProjectJobLock();
    this.#auditStore = auditStore ?? null;
    this.#resultStore = resultStore ?? null;
    this.#readPort = readPort ?? readLocalPreviewPort;
    this.#probeReachability = probeReachability ?? probeLocalReachability;
    this.#readCtrf = readCtrf ?? readCtrfResult;
    this.#readFile = readFileFn ?? readFile;
    this.#notifier = notifier ?? null;
    this.#readSuites = readSuites ?? readRegressionSuites;
    this.#vpsRegistry = vpsRegistry ?? null;
    this.#ensureTestDependencies = ensureTestDependenciesFn ?? ensureTestDependencies;
    this.#checkBrowserVersionGuard = checkBrowserVersionGuardFn ?? checkBrowserVersionGuard;
    this.#isContainerDeployment = isContainerDeployment ?? isRunningInContainer;
    this.#deployLoginService = deployLoginService ?? null;
    this.#decryptEnvGpg = decryptEnvGpg ?? defaultDecryptEnvGpg;
  }

  /**
   * Prüft, ob DIESES Runner-eigene Lock für ein Projekt bereits gehalten wird —
   * für den Busy-Check des Routers (AC2, "kein anderer Regressionslauf
   * desselben Projekts aktiv").
   *
   * @param {string} projectPath
   * @returns {boolean}
   */
  isRunning(projectPath) {
    return this.#lock.isHeld(projectPath);
  }

  /**
   * Startet einen Regressionslauf für ein Projekt (AC1/AC2/AC9). Erwirbt das
   * EIGENE, isolierte `ProjectJobLock` — freigegeben erst bei einem
   * terminalen Zustand.
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad.
   * @param {string} projekt - Projekt-Slug (für den Ergebnis-Store, AC9; auch Selbsttest-Erkennung, AC8).
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope - validierter Scope.
   * @param {object} [meta]
   * @param {string|null} [meta.identity] - für das Ende-/Fehler-Audit.
   * @param {boolean} [meta.freshRollout] - AC7: pull+recreate vor der Suite (nur `target: local`,
   *   server-seitig IGNORIERT bei Selbsttest — AC8).
   * @returns {{ ok: true, runId: string } | { ok: false, reason: 'locked' }}
   */
  start(projectPath, projekt, scope, { identity = null, freshRollout = false } = {}) {
    if (!this.#lock.tryAcquire(projectPath)) {
      return { ok: false, reason: 'locked' };
    }
    const runId = randomUUID();
    // A1: "Gesamt" (und ebenso bereich/verbund) = EIN Lauf-Datensatz;
    // `suite`-Label = gewählter Scope (bereich-id / verbund-name / "Gesamt").
    const suiteLabel = scope.typ === 'gesamt' ? 'Gesamt' : scope.id;
    // AC8: Selbsttest-Sonderfall — Frisch-Ausrollen server-seitig hart
    // übersprungen, UNABHÄNGIG vom übergebenen freshRollout-Wert (Edge-Case
    // „Selbsttest mit aktivierter Option via direktem API-Aufruf").
    const effectiveFreshRollout = Boolean(freshRollout) && !isSelfProject(projekt);
    this.#jobs.set(runId, {
      status: 'running',
      suite: suiteLabel,
      scopeTyp: scope.typ,
      projectPath,
      projekt,
      identity: identity ?? null,
      freshRollout: effectiveFreshRollout,
    });

    // Fire-and-forget: der Lauf kann mehrere Minuten dauern; der Aufrufer
    // (Router) wartet nicht.
    this.#runLifecycle(runId, scope).catch(() => {
      // #runLifecycle fängt selbst alle Fehler ab (Sicherheitsnetz).
    });
    return { ok: true, runId };
  }

  /**
   * Liest die ÖFFENTLICHE Sicht auf einen Lauf (Vertrag §Verträge GET) —
   * secret-frei, ohne interne Felder (`projectPath`/`identity`).
   *
   * @param {string} runId
   * @returns {object|undefined}
   */
  getRun(runId) {
    const job = this.#jobs.get(runId);
    if (!job) return undefined;
    const view = { status: job.status, suite: job.suite };
    if (job.target !== undefined) view.target = job.target;
    if (job.counts !== undefined) view.counts = job.counts;
    if (job.durationMs !== undefined) view.durationMs = job.durationMs;
    if (job.reason !== undefined) view.reason = job.reason;
    return view;
  }

  /**
   * Führt EINEN Regressionslauf vollständig aus: Testobjekt-Weiche (AC11),
   * local-Erreichbarkeitsprüfung (AC5), `npx playwright test`,
   * CTRF-Auswertung, Ergebnis-Übergabe (AC9, strukturell über `#finish`,
   * AC10).
   *
   * @param {string} runId
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
   * @returns {Promise<void>}
   */
  async #runLifecycle(runId, scope) {
    const job = this.#jobs.get(runId);
    if (!job) return;
    const start = Date.now();

    // Edge-Case: kein Projekt-Klon-Grundgerüst (tests/regression fehlt) →
    // klarer Fehler statt Crash/rotem Lauf.
    const testPath = scopeToTestPath(scope);
    const scaffoldExists = await this.#checkScaffold(job.projectPath);
    if (!scaffoldExists) {
      this.#finish(runId, 'error', { reason: NO_SCAFFOLD_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    // AC11: Testobjekt-Weiche VOR dem lokalen Pfad — dieselbe Lese-Boundary
    // wie der Ausführen-Dialog (kein zweiter Parser). `ephemeral-infra` hat
    // seit AC12 einen eigenen Ausführungspfad (#runEphemeralInfra). Ein
    // deklariertes, (noch) nicht gebautes Testobjekt (aktuell nur `url`)
    // endet weiterhin SOFORT als `error`, ohne Playwright-Start/
    // local-Erreichbarkeitsprüfung.
    const target = await this.#resolveTarget(job.projectPath, scope);
    if (target === 'ephemeral-infra') {
      await this.#runEphemeralInfra(runId, job, testPath, start);
      return;
    }
    if (target !== 'local') {
      this.#finish(runId, 'error', {
        reason: buildUnsupportedTargetMessage(target),
        ...(KNOWN_UNSUPPORTED_TARGETS.has(target) ? { target } : {}),
        durationMs: Date.now() - start,
      });
      return;
    }

    // regression-local-execution AC1/AC3: Test-Dependencies HERSTELLEN, BEVOR
    // überhaupt versucht wird, `npx playwright test` zu starten — nie der
    // bisherige unspezifische NO_CTRF_MESSAGE-Spätausfall für diese
    // Fehlerklasse (Befund 1).
    const depsOutcome = await this.#ensureTestDependencies(job.projectPath, { readFile: this.#readFile });
    if (!depsOutcome.ok) {
      this.#finish(runId, 'error', { reason: depsOutcome.reason, target: 'local', durationMs: Date.now() - start });
      return;
    }

    // regression-local-execution AC2/AC3: Browser-Versions-Guard — die im
    // Klon installierte @playwright/test-Version muss zur Referenz-Version
    // passen, gegen die das dev-gui-Image seine Browser installiert hat (A1).
    const browserOutcome = await this.#checkBrowserVersionGuard(job.projectPath, { readFile: this.#readFile });
    if (!browserOutcome.ok) {
      this.#finish(runId, 'precondition-error', { reason: browserOutcome.reason, target: 'local', durationMs: Date.now() - start });
      return;
    }

    // regression-local-execution AC5: port=null degradiert NICHT mehr still
    // — sofortiger precondition-error VOR jedem weiteren local-Schritt
    // (Frisch-Ausrollen/Erreichbarkeitsprüfung/REGRESSION_BASE_URL), statt
    // Playwright base-url-los zu starten (Befund 2b).
    const port = await this.#readPort(job.projectPath, { readFile: this.#readFile });
    if (port === null) {
      this.#finish(runId, 'precondition-error', { reason: PORT_NOT_RESOLVABLE_MESSAGE, target: 'local', durationMs: Date.now() - start });
      return;
    }

    // Lazy, EINMALIG pro Lauf gecachter `.claude/profile.md`-Rollout-Config-
    // Getter — sowohl AC7 (Frisch-Ausrollen) als auch AC6 (Container-Betrieb-
    // Adressierung) brauchen `image`/`container_port`; ohne diesen Getter
    // würde derselbe Lauf die Datei bei aktivem Frisch-Ausrollen zweimal
    // lesen (Review-Suggestion).
    let rolloutConfigPromise;
    const loadRolloutConfig = () => {
      rolloutConfigPromise ??= this.#readRolloutConfig(job.projectPath, { readFile: this.#readFile });
      return rolloutConfigPromise;
    };

    // AC7: Frisch-Ausrollen VOR der Erreichbarkeitsprüfung (pull + recreate,
    // niemals restart) — nur wenn angefordert (start()-Aufrufer hat AC8
    // bereits serverseitig erzwungen: job.freshRollout ist bei Selbsttest
    // immer false) UND eine dockerControl injiziert ist (sonst degradiert
    // auf die reine Erreichbarkeitsprüfung, kein Crash).
    if (job.freshRollout && this.#dockerControl) {
      const rolloutOutcome = await this.#performFreshRollout(job, port, loadRolloutConfig);
      if (rolloutOutcome && !rolloutOutcome.ok) {
        this.#finish(runId, rolloutOutcome.status, {
          reason: rolloutOutcome.reason,
          target: 'local',
          durationMs: Date.now() - start,
        });
        return;
      }
    }

    // AC6: dieselbe aufgelöste Adresse für die Erreichbarkeitsprüfung UND
    // REGRESSION_BASE_URL — Container-Betrieb adressiert das Nachbar-
    // Container-Testobjekt über host.docker.internal:<hostPort>, Host-Betrieb
    // bleibt 127.0.0.1:<port>.
    const address = await this.#resolveTargetAddress(job, port, loadRolloutConfig);
    const reachable = await this.#probeReachability(address);
    if (!reachable) {
      this.#finish(runId, 'precondition-error', { reason: PRECONDITION_MESSAGE, target: 'local', durationMs: Date.now() - start });
      return;
    }
    const baseUrl = `http://${address}`;

    // regression-local-execution AC7/AC8: App-Secrets NUR für den `local`-Pfad,
    // NACH erfolgreicher Erreichbarkeitsprüfung, AUSSCHLIESSLICH in die
    // Playwright-Kind-Env (nie Log/Audit/WS/argv/Platte, s. Modul-Doku +
    // resolveLocalRegressionSecrets()). Best-effort/degradierend (A2): liefert
    // `{}` ohne Runner-Fehlzustand, wenn Zugang/Item/`.env.gpg` fehlen.
    const secretEnv = await resolveLocalRegressionSecrets(job.projectPath, job.projekt, {
      deployLoginService: this.#deployLoginService,
      readFile: this.#readFile,
      decryptEnvGpg: this.#decryptEnvGpg,
      identity: job.identity,
    });

    let res;
    try {
      res = await this.#runPlaywright({ projectPath: job.projectPath, testPath, baseUrl, secretEnv });
    } catch {
      this.#finish(runId, 'error', { reason: INTERNAL_FAILURE_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    if (res?.spawnError) {
      const reason = res.notFound ? NOT_AVAILABLE_MESSAGE : GENERIC_FAILURE_MESSAGE;
      this.#finish(runId, 'error', { reason, durationMs: Date.now() - start });
      return;
    }
    if (res?.timedOut) {
      this.#finish(runId, 'error', { reason: TIMEOUT_FAILURE_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    const ctrf = await this.#readCtrf(job.projectPath, { readFile: this.#readFile });
    if (!ctrf) {
      this.#finish(runId, 'error', { reason: NO_CTRF_MESSAGE, durationMs: Date.now() - start });
      return;
    }

    const { counts, status } = summarizeCtrf(ctrf);
    const durationMs = Date.now() - start;

    // regression-failed-notification AC2/AC3: NUR bei status:"failed" (echte
    // rote Testfälle, aus summarizeCtrf()) — NIE bei precondition-error/error
    // (die erreichen diesen Codepfad ohnehin nie, s. Modul-Doku #runLifecycle).
    // Best-effort, non-fatal (DrainNotifier#notifyRegressionFailed wirft nie).
    if (status === 'failed') {
      this.#notifyRegressionFailed(job, counts);
    }

    // AC9/AC10: Ergebnis-Übergabe geschieht strukturell über #finish (EIN
    // aggregierter Datensatz, A1) — #finish selbst darf NICHT notifizieren
    // (s. Modul-Doku, Notify-Naht bleibt strukturell auf summarizeCtrf()
    // beschränkt).
    this.#finish(runId, status, { counts, durationMs, target: 'local', ctrf });
  }

  /**
   * Führt einen Lauf mit Testobjekt `ephemeral-infra` aus (AC12, A3). Die
   * eigentliche `rtest-*`-Provisionierung/-Teardown lebt fixture-scoped
   * INNERHALB der Playwright-Suite (agent-flow
   * `regression-playwright-conventions` AC4 — VERBINDLICH, dev-gui definiert
   * die Infra-Leitplanken nicht neu, s. Modul-Doku). Dieser Pfad spiegelt den
   * lokalen Pfad NUR für die Basis-URL (`REGRESSION_BASE_URL`, dieselbe
   * Port-Auflösung wie `local`, `#readPort`) — OHNE die local-Erreichbar-
   * keitsprüfung (AC5) und OHNE Frisch-Ausrollen (AC7 ist lokal-exklusiv).
   * Garantiertes Cleanup (AC12/agent-flow `regression-runner` AC8): dieser
   * Pfad ermittelt das Lauf-Ergebnis erst VOLLSTÄNDIG (`status`/`patch`, OHNE
   * `#finish` aufzurufen), fährt DANACH `#cleanupEphemeralInfra()` und ruft
   * `#finish()` — der die Lock-Freigabe auslöst — ERST NACH abgeschlossenem
   * Sweep auf. Reihenfolge zwingend: Ergebnis ermitteln → Sweep → `#finish`/
   * Lock-Release — in JEDEM Ausgang (passed/failed/error/Timeout/interner
   * Fehler). Begründung (Review-Fix Iteration 2): gäbe der Runner das Lock
   * frei, BEVOR der Sweep gelaufen ist, könnte ein sofort gestarteter
   * Folgelauf desselben Projekts (Busy-Check sieht "frei") seine frische
   * `rtest-*`-Maschine anlegen, die der noch laufende Sweep der Vorrunde dann
   * als vermeintliche Waise mitlöscht.
   *
   * @param {string} runId
   * @param {object} job
   * @param {string} testPath
   * @param {number} start
   * @returns {Promise<void>}
   */
  async #runEphemeralInfra(runId, job, testPath, start) {
    let status;
    let patch;

    try {
      const port = await this.#readPort(job.projectPath, { readFile: this.#readFile });
      const baseUrl = port !== null ? `http://127.0.0.1:${port}` : undefined;

      let res;
      let internalError = false;
      try {
        res = await this.#runPlaywright({ projectPath: job.projectPath, testPath, baseUrl });
      } catch {
        internalError = true;
      }

      if (internalError) {
        status = 'error';
        patch = { reason: INTERNAL_FAILURE_MESSAGE, target: 'ephemeral-infra', durationMs: Date.now() - start };
      } else if (res?.spawnError) {
        const reason = res.notFound ? NOT_AVAILABLE_MESSAGE : GENERIC_FAILURE_MESSAGE;
        status = 'error';
        patch = { reason, target: 'ephemeral-infra', durationMs: Date.now() - start };
      } else if (res?.timedOut) {
        status = 'error';
        patch = { reason: TIMEOUT_FAILURE_MESSAGE, target: 'ephemeral-infra', durationMs: Date.now() - start };
      } else {
        const ctrf = await this.#readCtrf(job.projectPath, { readFile: this.#readFile });
        if (!ctrf) {
          status = 'error';
          patch = { reason: NO_CTRF_MESSAGE, target: 'ephemeral-infra', durationMs: Date.now() - start };
        } else {
          const summary = summarizeCtrf(ctrf);
          status = summary.status;
          patch = { counts: summary.counts, durationMs: Date.now() - start, target: 'ephemeral-infra', ctrf };

          // regression-failed-notification AC2/AC3: NUR bei status:"failed".
          if (status === 'failed') {
            this.#notifyRegressionFailed(job, summary.counts);
          }
        }
      }
    } catch {
      // Sicherheitsnetz gegen einen unerwarteten Wurf ausserhalb der
      // expliziten Zweige oben (z.B. #readPort/#readCtrf — beide fangen
      // intern bereits alles ab, aber dieser Catch bleibt defensiv).
      status = 'error';
      patch = { reason: INTERNAL_FAILURE_MESSAGE, target: 'ephemeral-infra', durationMs: Date.now() - start };
    }

    // AC12/agent-flow `regression-runner` AC8: garantiertes Cleanup — VOR der
    // Lock-Freigabe (die erst in #finish passiert), damit kein Folgelauf
    // desselben Projekts in die Sweep-Lücke starten kann (Review-Fix
    // Iteration 2). Best-effort, kein Crash — läuft in JEDEM Ausgang.
    await this.#cleanupEphemeralInfra();
    this.#finish(runId, status, patch);
  }

  /**
   * Best-effort Sicherheitsnetz-Sweep (AC12): löscht JEDE über alle
   * konfigurierten VPS-Provider gelistete Maschine mit `rtest-*`-Namens-
   * präfix. Läuft IMMER nach einem `ephemeral-infra`-Lauf (`finally`,
   * s. `#runEphemeralInfra`) — zusätzlich zum In-Test-Fixture-Teardown
   * (regression-playwright-conventions AC4), als Rückfallebene für den Fall,
   * dass der Runner-eigene Runaway-Timeout den Playwright-Kindprozess killt,
   * BEVOR dessen eigener Teardown lief. Produktiv-Allowlist (AC7): rührt
   * AUSSCHLIESSLICH `rtest-*`-Namen an — alles andere bleibt unberührt. Ohne
   * injizierte `vpsRegistry` (Default) No-op, kein Crash (degradiert analog
   * `dockerControl`). Einzelne Lösch-/Listing-Fehler werden protokolliert
   * (secret-frei) und stoppen den Sweep nicht (best-effort je Maschine).
   *
   * @returns {Promise<void>}
   */
  async #cleanupEphemeralInfra() {
    if (!this.#vpsRegistry || typeof this.#vpsRegistry.listAllMachines !== 'function' || typeof this.#vpsRegistry.delete !== 'function') {
      return; // kein Registry injiziert -> best-effort übersprungen (kein Crash)
    }
    let machines;
    try {
      const result = await this.#vpsRegistry.listAllMachines();
      machines = Array.isArray(result?.machines) ? result.machines : [];
    } catch (err) {
      console.error('[RegressionRunner] rtest-*-Cleanup: Listing fehlgeschlagen (best-effort):', err?.message ?? String(err));
      return;
    }

    const orphans = machines.filter((m) => typeof m?.name === 'string' && m.name.startsWith(RTEST_PREFIX));
    for (const machine of orphans) {
      try {
        await this.#vpsRegistry.delete(machine.provider, machine.serverId, machine.name);
      } catch (err) {
        console.error('[RegressionRunner] rtest-*-Cleanup: Abbau fehlgeschlagen (best-effort):', err?.message ?? String(err));
      }
    }
  }

  /**
   * Löst das für den gewählten Scope deklarierte `target` auf (AC11) — über
   * DIESELBE Lese-Boundary wie der Ausführen-Dialog (`readRegressionSuites`,
   * AC4/AC6, kein zweiter Parser). `gesamt` mischt Testobjekte und läuft
   * IMMER über den local-Pfad (Bestandsverhalten, AC11 letzter Satz) —
   * `readRegressionSuites` wird dafür gar nicht erst aufgerufen. Fehlt das
   * `target` (keine/unlesbare Begleitbeschreibung, Suite nicht (mehr)
   * gefunden, Lesefehler) → konservativ `'local'`.
   *
   * @param {string} projectPath
   * @param {{ typ: 'bereich'|'verbund'|'gesamt', id?: string }} scope
   * @returns {Promise<string>} `'local'` oder der roh deklarierte `target`-Wert.
   */
  async #resolveTarget(projectPath, scope) {
    if (scope.typ === 'gesamt') return 'local';
    let result;
    try {
      result = await this.#readSuites(projectPath);
    } catch {
      return 'local'; // Lesefehler -> konservativ local (AC11)
    }
    const suites = Array.isArray(result?.suites) ? result.suites : [];
    const match = suites.find((s) => {
      if (!s?.scope || s.scope.typ !== scope.typ) return false;
      return scope.typ === 'bereich' ? s.scope.id === scope.id : true;
    });
    return match?.target ?? 'local'; // kein target deklariert -> konservativ local (AC11)
  }

  /**
   * Stößt best-effort GENAU EINEN `regression_failed`-Push an
   * (regression-failed-notification AC1–AC4). No-op ohne injizierten
   * `#notifier` (Default-Regress, degradiert auf reines Lauf-Ergebnis ohne
   * Push). Fire-and-forget — ein Fehler des Notifiers darf den Lauf-Abschluss
   * nie beeinträchtigen (der Notifier selbst fängt bereits alle Fehler,
   * dieser Wrapper ist zusätzliche Tiefenverteidigung).
   *
   * @param {{ projekt: string, suite: string }} job
   * @param {{ failed: number, total: number }} counts
   */
  #notifyRegressionFailed(job, counts) {
    if (!this.#notifier || typeof this.#notifier.notifyRegressionFailed !== 'function') return;
    try {
      this.#notifier
        .notifyRegressionFailed({ projekt: job.projekt, suite: job.suite, failed: counts.failed, total: counts.total })
        .catch((err) => {
          console.error('[RegressionRunner] regression_failed-Push fehlgeschlagen (best-effort):', err?.message ?? String(err));
        });
    } catch (err) {
      console.error('[RegressionRunner] regression_failed-Push fehlgeschlagen (best-effort):', err?.message ?? String(err));
    }
  }

  /**
   * Frisch-Ausrollen (AC7): liest `image`/`container_port` aus dem
   * Projekt-Profil und ruft `LocalDockerControl#pullAndRecreate` (bestehende
   * cicd/preview-Rollout-Mechanik, kein neuer Rollout-Pfad). Kein `image`
   * auffindbar → best-effort übersprungen (kein Fehler, degradiert auf reine
   * Erreichbarkeitsprüfung — Edge-Case „kein Profil"). Pull-/Start-Fehler →
   * `error` mit Grund; Readiness-Timeout → `precondition-error` (Edge-Cases
   * §Spec). Der Container-Name wird NICHT aus dem rohen, case-erhaltenden
   * `job.projekt`-Slug übernommen, sondern aus `rolloutConfig.image` exakt
   * nach der `/preview up`-Konvention abgeleitet (`deriveContainerNameFromImage`,
   * letztes Image-Segment, lowercase) — sonst greift `pullAndRecreate` bei
   * Projekten mit Großbuchstaben im Repo-Namen am laufenden Preview-Container
   * vorbei (Review-Fix S-310 Iteration 2).
   *
   * Nimmt `loadRolloutConfig` als injizierten Getter entgegen (statt selbst
   * `#readRolloutConfig` aufzurufen) — dieselbe, EINMALIG pro Lauf gelesene
   * Instanz wird auch von `#resolveTargetAddress` (AC6) verwendet, damit
   * `.claude/profile.md` innerhalb EINES Laufs nicht zweimal gelesen wird
   * (Review-Suggestion).
   *
   * @param {{ projectPath: string, projekt: string }} job
   * @param {number} port - `preview_port` (Host-Port).
   * @param {() => Promise<{image:string,containerPort:number|null}|null>} loadRolloutConfig - lazy, gecachter Getter.
   * @returns {Promise<{ ok: true } | { ok: false, status: 'error'|'precondition-error', reason: string } | undefined>}
   */
  async #performFreshRollout(job, port, loadRolloutConfig) {
    const rolloutConfig = await loadRolloutConfig();
    if (!rolloutConfig || !rolloutConfig.image) {
      // Kein Profil/kein image auffindbar — best-effort übersprungen, kein Crash.
      return undefined;
    }
    try {
      const { ready } = await this.#dockerControl.pullAndRecreate({
        image: rolloutConfig.image,
        containerName: deriveContainerNameFromImage(rolloutConfig.image),
        hostPort: port,
        containerPort: rolloutConfig.containerPort ?? port,
      });
      if (!ready) {
        return { ok: false, status: 'precondition-error', reason: ROLLOUT_NOT_READY_MESSAGE };
      }
      return { ok: true };
    } catch (err) {
      const reason = err?.errorClass ? `${ROLLOUT_FAILURE_MESSAGE}: ${err.errorClass}` : ROLLOUT_FAILURE_MESSAGE;
      return { ok: false, status: 'error', reason };
    }
  }

  /**
   * Löst die Ziel-Adresse für die local-Erreichbarkeitsprüfung UND
   * `REGRESSION_BASE_URL` auf — DIESELBE Adresse für beide (AC6). Host-
   * Betrieb (Bestandsverhalten, unverändert): `127.0.0.1:<port>`. Container-
   * Betrieb (dieser Runner-Prozess läuft selbst in einem Docker-Container,
   * `#isContainerDeployment`): `host.docker.internal:<hostPort>` —
   * `<hostPort>` wird NACH MÖGLICHKEIT aus dem tatsächlichen Docker-Port-
   * Mapping des Ziel-Containers ermittelt (`LocalDockerControl#getMappedHostPort`,
   * dieselbe cicd/preview-Boundary wie Frisch-Ausrollen AC7 — kein zweiter
   * Docker-Read-Pfad), NICHT aus dem Container-internen EXPOSE-Port (Befund 3,
   * `8080→8081`). Ohne auflösbares `image` in `.claude/profile.md`, ohne
   * injizierte `dockerControl`/`getMappedHostPort`-Methode oder ohne
   * Mapping-Treffer degradiert die Funktion best-effort auf den statisch
   * gelesenen `<port>` (kein Crash — eine sonst gültige Adresse darf nicht an
   * einer optionalen Verfeinerung scheitern).
   *
   * Selbsttest-Sonderfall (`isSelfProject`, AC6 letzter Satz „bleibt
   * unberührt"): läuft dieser Runner GEGEN SICH SELBST (dev-gui), teilt der
   * gespawnte Playwright-Kindprozess DIESELBE Netzwerk-Namespace wie der
   * getestete dev-gui-Server (derselbe Container/Prozessbaum) — `127.0.0.1`
   * erreicht ihn IMMER direkt per Loopback, unabhängig vom Deployment. Ein
   * Umweg über `host.docker.internal` wäre hier unnötig (setzt zusätzlich
   * NAT-Hairpinning auf dem Host voraus) und bleibt daher bewusst aus.
   *
   * Nimmt `loadRolloutConfig` als injizierten, lazy-gecachten Getter entgegen
   * (statt selbst `#readRolloutConfig` aufzurufen) — vermeidet einen zweiten
   * `.claude/profile.md`-Read, falls `#performFreshRollout` in DIESEM Lauf
   * bereits gelesen hat (Review-Suggestion, kein funktionaler Unterschied).
   *
   * @param {{ projectPath: string, projekt: string }} job
   * @param {number} port - der bereits gelesene lokale Port (`#readPort`, AC4/AC5).
   * @param {() => Promise<{image:string,containerPort:number|null}|null>} loadRolloutConfig - lazy, gecachter Getter.
   * @returns {Promise<string>} z.B. `127.0.0.1:8080` oder `host.docker.internal:8081`.
   */
  async #resolveTargetAddress(job, port, loadRolloutConfig) {
    if (!this.#isContainerDeployment() || isSelfProject(job.projekt)) {
      return `127.0.0.1:${port}`;
    }

    let hostPort = port;
    if (this.#dockerControl && typeof this.#dockerControl.getMappedHostPort === 'function') {
      const rolloutConfig = await loadRolloutConfig();
      if (rolloutConfig?.image) {
        const containerName = deriveContainerNameFromImage(rolloutConfig.image);
        const containerPort = rolloutConfig.containerPort ?? port;
        const mapped = await this.#dockerControl.getMappedHostPort(containerName, containerPort);
        if (mapped !== null) hostPort = mapped;
      }
    }
    return `${DOCKER_HOST_GATEWAY}:${hostPort}`;
  }

  /**
   * Prüft, ob der Projekt-Klon ein Regressions-Grundgerüst hat
   * (`tests/regression`-Verzeichnis existiert). Best-effort — ein Lesefehler
   * zählt als "fehlt" (kein Crash).
   *
   * @param {string} projectPath
   * @returns {Promise<boolean>}
   */
  async #checkScaffold(projectPath) {
    try {
      await this.#readFile(join(projectPath, REGRESSION_TESTS_ROOT), 'utf8');
      return true; // ein Verzeichnis als 'utf8' zu lesen wirft (EISDIR) — s.u.
    } catch (err) {
      // EISDIR: der Pfad existiert UND ist ein Verzeichnis → Grundgerüst da.
      // ENOENT/anderes: kein Grundgerüst.
      return err?.code === 'EISDIR';
    }
  }

  /**
   * Übergibt EINEN Lauf-Datensatz an den `RegressionResultStore` (AC9/AC10,
   * best-effort — ein Store-Fehler crasht den Runner nicht, der Lauf-Status
   * selbst bleibt korrekt, nur die Persistenz kann fehlen). Wird
   * AUSSCHLIESSLICH von `#finish` gerufen (strukturelle Garantie AC10: JEDER
   * terminale Zustand — auch ein Frühausfall ohne CTRF — landet hier genau
   * einmal). Ohne CTRF (Frühausfall) wird `ctrf: null` übergeben (KEIN
   * synthetisches Ersatz-CTRF, [[regression-result-store]] AC1b); `reason`
   * wird NUR bei `precondition-error`/`error` gesetzt.
   *
   * S-327: `artifactsSourceDir` wird IMMER (unabhängig vom Status) als der
   * validierte, absolute Projekt-Klon-Pfad übergeben — der Store entscheidet
   * selbst (Rot/Grün-Default, `REGRESSION_KEEP_ARTIFACTS_ON_PASS`, Retention),
   * ob + welche Artefakte er daraus in seine eigene Lauf-Ablage kopiert
   * (docs/specs/regression-result-store.md AC3). Dieser Runner selbst baut
   * KEINE `artifacts`-Referenz mehr.
   *
   * @param {{ projekt: string, suite: string, scopeTyp: string, projectPath: string }} job
   * @param {'passed'|'failed'|'precondition-error'|'error'} status
   * @param {{ counts?: object, ctrf?: object, durationMs?: number, reason?: string }} patch
   */
  async #persistToStore(job, status, { counts, ctrf, durationMs, reason }) {
    if (!this.#resultStore || typeof this.#resultStore.record !== 'function') return;
    try {
      const input = {
        projekt: job.projekt,
        suite: job.suite,
        scopeTyp: job.scopeTyp,
        status,
        startedAt: new Date(Date.now() - (durationMs ?? 0)).toISOString(),
        durationMs: durationMs ?? 0,
        counts: counts ?? { passed: 0, failed: 0, total: 0 },
        // AC10/AC1b: kein CTRF bei einem Frühausfall -> ctrf:null, KEIN
        // synthetisches Ersatz-CTRF.
        ctrf: ctrf ?? null,
        // S-327: artifactsSourceDir IMMER übergeben — der Store entscheidet
        // selbst über Kopie/Retention/Relativierung. Der Runner baut keine
        // artifacts-Referenz mehr (bei Frühausfall existiert im Klon ohnehin
        // kein playwright-report/ — fs.cp ist best-effort, kein Crash).
        artifactsSourceDir: job.projectPath,
      };
      // AC1b: reason NUR bei precondition-error/error (bei passed/failed abwesend).
      if ((status === 'precondition-error' || status === 'error') && reason) {
        input.reason = reason;
      }
      await this.#resultStore.record(input);
    } catch (err) {
      console.error('[RegressionRunner] Ergebnis-Übergabe fehlgeschlagen:', err?.message ?? String(err));
    }
  }

  /**
   * Setzt einen Lauf terminal, gibt das Lock frei (immer), schreibt genau
   * EINEN Ende-/Fehler-Audit-Eintrag (secret-frei) und übergibt best-effort
   * GENAU EINEN Datensatz an den `RegressionResultStore` (AC10, S-326) —
   * strukturell für JEDEN terminalen Zustand, auch ohne CTRF (Frühausfall).
   * Reihenfolge (bindend, Modul-Doku): Status → Lock-Freigabe → Audit →
   * Store — Lock-Freigabe VOR dem best-effort-Store-Schreibzugriff, damit ein
   * hängender/fehlschlagender Store NIE ein Lock hält. `#finish` selbst
   * notifiziert NIE (die Notify-Naht bleibt strukturell auf den
   * `summarizeCtrf()`-Erfolgspfad in `#runLifecycle` beschränkt,
   * regression-failed-notification AC2/AC3).
   *
   * @param {string} runId
   * @param {'passed'|'failed'|'precondition-error'|'error'} status
   * @param {{ counts?: object, ctrf?: object, durationMs?: number, reason?: string, target?: string }} patch
   */
  #finish(runId, status, patch) {
    const job = this.#jobs.get(runId);
    if (!job) return;
    job.status = status;
    if (patch.counts !== undefined) job.counts = patch.counts;
    if (patch.durationMs !== undefined) job.durationMs = patch.durationMs;
    if (patch.reason !== undefined) job.reason = patch.reason;
    if (patch.target !== undefined) job.target = patch.target;

    // Lock IMMER freigeben (terminaler Zustand) — VOR dem Store-Schreibzugriff.
    this.#lock.release(job.projectPath);

    if (status === 'passed') {
      this.#audit(job.identity, `regression-run:done:${runId}`);
    } else {
      this.#audit(job.identity, `regression-run:error:${runId}:${status}`);
    }

    // AC10: strukturelle, ausnahmslose Diagnose-Pflicht — best-effort, ein
    // Store-Fehler darf den Lauf-Abschluss (bereits oben erfolgt) nie
    // verhindern.
    this.#persistToStore(job, status, patch).catch(() => {
      // #persistToStore fängt selbst bereits alle Fehler ab (Sicherheitsnetz).
    });
  }

  /**
   * Best-effort Audit. Ein Audit-Fehler crasht den Runner nie (analog
   * `RegressionDefineRunner#audit`).
   * @param {string|null} identity
   * @param {string} command
   */
  #audit(identity, command) {
    if (!this.#auditStore) return;
    try {
      this.#auditStore.record({ identity: identity ?? null, command });
    } catch {
      // best-effort — kein Crash, kein Secret im Log.
    }
  }
}
