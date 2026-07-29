/**
 * HeadlessRedTeamRunner — echter `claude -p`-Kindprozess-Runner für
 * `/agent-flow:red-team` (docs/specs/red-team-tile.md AC1).
 *
 * Getrennt vom interaktiven PTY-Pfad: dieses Modul importiert/mutiert WEDER
 * `PtyManager` NOCH `PtySessionRegistry` NOCH den `CommandService`-Schreibpfad.
 * Der bestehende `/api/command`-Flow (Flow-/Board-Button) bleibt unangetastet.
 *
 * Analog zu `HeadlessReconcileRunner.js` ein dünner Wrapper um
 * `HeadlessRunnerCore` (docs/specs/headless-parallel-drain.md AC2) mit fest
 * verdrahtetem Befehl `/agent-flow:red-team` und red-team-spezifischen
 * Meldungstexten. Verhalten (spawn/env/timeout/lock/close-Semantik) erbt 1:1
 * aus dem Core — kein Regress gegenüber den Geschwister-Runnern.
 *
 * Besonderheit gegenüber Reconcile: der Red-Team-Lauf braucht Per-Lauf-
 * Argumente (`ziel`, optional `modus`, optional `url`/`urlEdge` für den scharfen
 * Betrieb F-032 / Spec AC12). Diese werden als args-Array an den Core
 * durchgereicht und dort zu EINEM zusammenhängenden `-p`-argv-Element
 * (`/agent-flow:red-team ziel=<slug> [modus=<modus>] [url=<url>] [url_edge=<urlEdge>]`)
 * zusammengesetzt.
 *
 * Trust-Boundary: `ziel` ist ein bereits validierter Slug — der Aufrufer/Router
 * prüft ihn gegen die Allowlist, BEVOR `start()` gerufen wird. Der Runner
 * vertraut dem übergebenen Wert und interpoliert ihn nicht in eine Shell
 * (argv-Array, kein Shell-String, security/R03). Als defensive Basis wirft
 * `start()` bei fehlendem/leerem `ziel` einen `TypeError`, statt einen leeren
 * `ziel=`-Parameter an den Kindprozess zu reichen. Ebenso Trust-Boundary bei
 * `url`/`urlEdge`: die Pflicht für scharfe Läufe erzwingt der Router/Agent, NICHT
 * der Runner — dieser reicht nur durch und lässt sie weg, wenn nicht gesetzt.
 *
 * Injectable (Test-Entkopplung): `spawnFn` (Default `node:child_process` `spawn`),
 * kein Test benötigt einen echten `claude`-Lauf.
 *
 * Ausgabe-Exposition (AC25, docs/specs/red-team-scan-per-container.md — additiv, kein
 * Regress der Geschwister-Runner): dieser Runner aktiviert `captureOutput: true` am
 * `HeadlessRunnerCore`, den EINZIGEN opt-in Core-Nutzer bisher — `getJob()` liefert damit
 * zusätzlich ein `output`-Feld (die bereits erfasste stdout+stderr-Kombination, dieselbe
 * Ausgabe wie für die bestehende 401-/Budget-Erkennung im Core) im terminalen Job-Zustand.
 * Die übrigen Core-Nutzer (`HeadlessReconcileRunner`, `HeadlessFlowRunner`,
 * `HeadlessRetroRunner`, `ObsidianIngestRunner`, …) setzen `captureOutput` nicht und bleiben
 * dadurch byte-identisch (Core-Default `false`, kein zusätzlicher Job-Key). `output` ist
 * für den fail-safe Funde-/Prüfpunkt-Parser gedacht (`src/redTeamOutputParser.js`, AC24) —
 * WER `parseRedTeamOutput(job.output)` nach Abschluss aufruft und daraus persistiert
 * (`ScanResultStore.record()`), ist eine offene Folge-Naht (S-411+, nicht Teil dieser Story).
 *
 * Cloudflare-Access-Service-Token (AC2/AC5, docs/specs/red-team-scan-access-token.md,
 * Ausbaustufe 2 — S-407): optionaler `start()`-Parameter `accessToken` (`{ clientId,
 * clientSecret }`). Simplicity-Leiter Stufe 2 (coder/R09): wiederverwendet den bereits
 * bestehenden Pro-Lauf-Env-Override (ADR-021, `overrides.env` am Core) statt einen neuen
 * Durchreich-Mechanismus zu bauen — argv/Env-diszipliniert: nur ein nicht-geheimer Marker
 * geht ins argv, die Werte selbst NUR über die additive Child-Env (nie geloggt).
 *
 * @module HeadlessRedTeamRunner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { ProjectJobLock } from './ProjectJobLock.js';
import {
  HeadlessRunnerCore,
  buildChildEnv,
  isAuthError,
  extractPrHint,
  AUTH_EXPIRED_MESSAGE,
} from './HeadlessRunnerCore.js';

/** Default Runaway-Timeout (Red-Team-Lauf kann mehrere Minuten dauern — grosszügig). */
export const DEFAULT_RED_TEAM_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

// Re-exportiert für Rückwärtskompatibilität — bestehende Importe aus diesem Modul
// (Tests, Aufrufer) bleiben unverändert gültig.
export { buildChildEnv, isAuthError, extractPrHint, AUTH_EXPIRED_MESSAGE };

const RED_TEAM_COMMAND = '/agent-flow:red-team';

/** Generischer, secret-freier Fehlertext für nicht-401 Exit-Fehler. */
const GENERIC_FAILURE_MESSAGE = 'Red-Team-Lauf fehlgeschlagen';
const TIMEOUT_FAILURE_MESSAGE = 'Red-Team-Lauf abgebrochen (Timeout)';
const INTERNAL_FAILURE_MESSAGE = 'Interner Fehler im Red-Team-Runner';
const DONE_RESULT_MESSAGE = 'Red-Team-Lauf abgeschlossen';

/**
 * HeadlessRedTeamRunner — Kindprozess-Runner + In-Memory Job-Registry.
 * Dünner Wrapper um `HeadlessRunnerCore` mit fest verdrahtetem
 * `/agent-flow:red-team`-Befehl (kein Befehls-Override) und Per-Lauf-
 * Argumenten (`ziel`, optional `modus`).
 */
export class HeadlessRedTeamRunner {
  /** @type {HeadlessRunnerCore} */
  #core;

  /**
   * @param {object} [params]
   * @param {Function} [params.spawnFn] - injectable spawn (default: node:child_process spawn).
   * @param {number} [params.timeoutMs] - Runaway-Timeout (default: RED_TEAM_TIMEOUT_MS env
   *   oder DEFAULT_RED_TEAM_TIMEOUT_MS).
   * @param {ProjectJobLock} [params.lock] - injectable Lock-Instanz (default: eigene, isoliert
   *   von den übrigen Headless-Runnern).
   */
  constructor({ spawnFn = nodeSpawn, timeoutMs, lock = new ProjectJobLock() } = {}) {
    this.#core = new HeadlessRunnerCore({
      spawnFn,
      timeoutMs: timeoutMs ?? (Number(process.env.RED_TEAM_TIMEOUT_MS) || DEFAULT_RED_TEAM_TIMEOUT_MS),
      lock,
      defaultCommand: RED_TEAM_COMMAND,
      defaultArgs: [],
      messages: {
        genericFailure: GENERIC_FAILURE_MESSAGE,
        timeoutFailure: TIMEOUT_FAILURE_MESSAGE,
        internalFailure: INTERNAL_FAILURE_MESSAGE,
        doneResult: DONE_RESULT_MESSAGE,
      },
      // AC25: opt-in Ausgabe-Exposition — NUR dieser Runner setzt captureOutput, die
      // Geschwister-Runner bleiben unverändert (Core-Default false).
      captureOutput: true,
    });
  }

  /**
   * Startet einen Red-Team-Job für ein Projekt (docs/specs/red-team-tile.md AC1,
   * scharfer Betrieb F-032 / Spec AC12).
   *
   * Baut die Per-Lauf-Argumente `['ziel=<ziel>']` (plus `'modus=<modus>'`,
   * `'url=<url>'`, `'url_edge=<urlEdge>'`, jeweils nur wenn gesetzt) in fester
   * Reihenfolge `ziel, modus, url, url_edge` und reicht sie als `overrides.args`
   * an den Core, der sie zu EINEM `-p`-argv-Element
   * `/agent-flow:red-team ziel=<ziel> [modus=<modus>] [url=<url>] [url_edge=<urlEdge>]`
   * zusammensetzt.
   *
   * Trust-Boundary: `ziel` ist ein bereits validierter Slug — der Aufrufer/Router
   * hat ihn GEGEN DIE ALLOWLIST GEPRÜFT, bevor `start()` gerufen wird. Der Runner
   * vertraut dem Wert (kein Re-Validieren), interpoliert ihn aber nicht in eine
   * Shell (argv-Array, security/R03). Fehlt/leer → `TypeError` (defensive Basis
   * gegen einen leeren `ziel=`-Parameter).
   *
   * `url`/`urlEdge` sind hier OPTIONAL: die Pflicht für scharfe Läufe erzwingt der
   * Router/Agent vor dem Aufruf, nicht der Runner. Falls gesetzt, müssen sie aber
   * Strings OHNE Leerzeichen sein — ein Leerzeichen würde das zusammengesetzte
   * `-p`-argv-Element in mehrere Prompt-Tokens zerlegen und so einen fremden
   * Parameter einschmuggeln. Verletzung → `TypeError` (bewusst konsistent mit
   * `ziel`, statt still zu ignorieren: ein kaputter URL-Wert soll sichtbar
   * scheitern, nicht unbemerkt weggelassen werden).
   *
   * `accessToken` (red-team-scan-access-token AC2/AC5, Ausbaustufe 2 — Scan hinter der
   * Access-Wall): OPTIONAL, `{ clientId, clientSecret }`. Die beiden Werte gehen **nie**
   * ins argv (Security-Floor) — nur ein nicht-geheimer argv-Marker (`access_header=cf-access`)
   * signalisiert dem Agenten, dass er die Header aus der Umgebung lesen soll; die
   * eigentlichen Werte reicht der Core additiv über den bestehenden Pro-Lauf-Env-Override
   * (ADR-021, `overrides.env`) als `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` durch
   * (nie geloggt, s. `HeadlessRunnerCore#buildChildEnv`). Fehlt `clientId`/`clientSecret`
   * bzw. sind sie kein nicht-leerer String → `TypeError` (defensive Basis, analog `ziel`).
   *
   * @param {string} projectPath - aufgelöster, validierter absoluter Projekt-Pfad (WORKSPACE_DIR/<slug>).
   * @param {object} [params]
   * @param {string} params.ziel - validierter Ziel-Slug (Pflicht).
   * @param {string} [params.modus] - optionaler Red-Team-Modus.
   * @param {string} [params.url] - optionale Ziel-URL (scharfer Betrieb); String ohne Leerzeichen.
   * @param {string} [params.urlEdge] - optionale Edge-/Public-URL (scharfer Betrieb); String ohne Leerzeichen.
   * @param {{ clientId: string, clientSecret: string }} [params.accessToken] - optionales
   *   Cloudflare-Access-Service-Token (red-team-scan-access-token AC2) — nie im argv, nur
   *   als Pro-Lauf-Env-Override.
   * @returns {{ ok: true, jobId: string } | { ok: false, reason: 'locked' }}
   * @throws {TypeError} wenn `ziel` fehlt/leer ist, wenn `url`/`urlEdge` gesetzt, aber kein
   *   String bzw. mit Leerzeichen sind, oder wenn `accessToken` gesetzt, aber
   *   `clientId`/`clientSecret` kein nicht-leerer String sind.
   */
  start(projectPath, { ziel, modus, url, urlEdge, accessToken } = {}) {
    if (!ziel) {
      throw new TypeError('HeadlessRedTeamRunner.start: "ziel" ist erforderlich (validierter Slug)');
    }
    const args = ['ziel=' + ziel];
    if (modus) {
      args.push('modus=' + modus);
    }
    if (url) {
      if (typeof url !== 'string' || /\s/.test(url)) {
        throw new TypeError('HeadlessRedTeamRunner.start: "url" muss ein String ohne Leerzeichen sein');
      }
      args.push('url=' + url);
    }
    if (urlEdge) {
      if (typeof urlEdge !== 'string' || /\s/.test(urlEdge)) {
        throw new TypeError('HeadlessRedTeamRunner.start: "urlEdge" muss ein String ohne Leerzeichen sein');
      }
      args.push('url_edge=' + urlEdge);
    }
    let env;
    if (accessToken) {
      const { clientId, clientSecret } = accessToken;
      if (
        typeof clientId !== 'string' || !clientId.trim()
        || typeof clientSecret !== 'string' || !clientSecret.trim()
      ) {
        throw new TypeError(
          'HeadlessRedTeamRunner.start: "accessToken" braucht "clientId"+"clientSecret" als nicht-leere Strings',
        );
      }
      // AC2/AC5 (red-team-scan-access-token): nur ein nicht-geheimer argv-Marker — die
      // Werte selbst gehen über den Pro-Lauf-Env-Override (s. Moduldoku oben).
      args.push('access_header=cf-access');
      env = { CF_ACCESS_CLIENT_ID: clientId, CF_ACCESS_CLIENT_SECRET: clientSecret };
    }
    return this.#core.start(projectPath, { args, env });
  }

  /**
   * Liest den aktuellen Status eines Jobs.
   *
   * `output` (AC25): die erfasste stdout+stderr-Kombination des Laufs — nur bei diesem
   * Runner vorhanden (`captureOutput: true`, s. Moduldoku), gedacht als Eingabe für
   * `parseRedTeamOutput()` (`src/redTeamOutputParser.js`, AC24).
   *
   * @param {string} jobId
   * @returns {{ status: string, result?: string, error?: string, prHint?: string, output?: string } | undefined}
   */
  getJob(jobId) {
    return this.#core.getJob(jobId);
  }
}
