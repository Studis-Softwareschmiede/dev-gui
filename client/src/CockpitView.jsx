/**
 * CockpitView.jsx — Projekt-Cockpit mit Reiter-Leiste.
 *
 * projekt-cockpit-navigation:
 *   AC3 — Reiter-Leiste „Arbeiten | Studis-Kanban-Board | Spezifikation" mit aktivem Projekt-Kontext.
 *          „Arbeiten" zeigt den FactoryWorkspace-Inhalt (Aktions-/Button-Spalte +
 *          optionale Terminal-Fläche) — SUPERSEDED für das Terminal-Pane durch
 *          fabrik-arbeiten-layout AC1 (s.u.): kein dominantes eingebettetes Terminal mehr im
 *          Standard-Layout. TriggerPanel entfernt (cockpit-declutter AC1, S-303); Status-
 *          Dashboard-Kachel entfernt (cockpit-declutter AC2, S-304).
 *          Reiter erben den Projekt-Kontext (activeRepo).
 *   AC2 — Rückweg zur Übersicht (#/factory) über den Back-Button.
 *
 * projekt-spezifikation-anzeige:
 *   AC4 — Reiter „Spezifikation" ersetzt den „folgt mit F-004"-Platzhalter:
 *          SpecView mit Navigation + gerendertem Markdown (markdownLite).
 *   AC5 — BoardView erhält openSpec-Callback: Klick auf Spec-Bezug öffnet
 *          den Spezifikation-Reiter und zeigt die jeweilige Datei.
 *
 * autonome-board-abarbeitung:
 *   AC2 — Im Reiter „Arbeiten" Knopf „Board abarbeiten", der mit
 *          Bestätigungsdialog das aktive Projekt-Board abarbeitet (s. AC12
 *          taktgeber-nachtwaechter unten für den aktuellen Auslöse-Mechanismus).
 *   AC3 — Hinweis: offene Fragen → Story auf Blocked statt raten.
 *
 * fabric-intake-dialog:
 *   AC8 — „Board abarbeiten"-Button (Phase B) ist bei aktivem Job (Session
 *          state:"busy") deaktiviert (globales Lock-Modell). Nach erfolgreichem
 *          Auslösen (202) → onNavigate('factory') damit der Lauf live im
 *          Terminal sichtbar ist.
 *
 * taktgeber-nachtwaechter (S-196):
 *   AC12 — Umbau: der Knopf ruft nicht mehr direkt POST /api/command mit
 *          einem einzelnen /agent-flow:flow-Schuss auf, sondern
 *          POST /api/projects/:slug/drain — dieser Endpunkt startet die
 *          zentrale ProjectDrain-Engine (S-192), die /agent-flow:flow
 *          wiederholt anstößt, bis das Board des Projekts keine offene
 *          Drain-Ziel-Story mehr hat (sofort, ohne Nachtfenster-Gate,
 *          Parallelität 1). 202 {drainId} → weiterhin onNavigate('factory')
 *          (Terminal-Pane, AC8-Muster); 409 → Fehler-Info (Projekt bereits
 *          busy). Der /flow-Lauf selbst bleibt weiterhin über CommandService
 *          im Projekt-Terminal sichtbar (kein neuer Completion-Kanal nötig).
 *
 * headless-manual-drain (S-224):
 *   AC5 — Cost-Mode-Dropdown (4-Wege low-cost|balanced|max-quality|frontier,
 *          Default balanced, grobe Tier-/Kosten-Orientierung + Abo-Disclaimer,
 *          geteilt via costMode.js) sitzt DIREKT beim „Board abarbeiten"-Knopf
 *          und wird als `{ costMode }` im JSON-Body an POST …/drain gesendet.
 *   AC6 — Da der Drain seit ADR-017 HEADLESS läuft (kein PTY, keine Live-
 *          Terminal-Ausgabe), navigiert der 202-Pfad NICHT mehr in den Terminal-
 *          Pane (supersedes fabric-intake-dialog AC8 / taktgeber-nachtwaechter
 *          AC12 „onNavigate('factory')" für DIESEN Knopf). Stattdessen pollt das
 *          Panel GET …/drain/:drainId und zeigt den Status INLINE neben dem Knopf
 *          („läuft…" | „fertig" | „fehlgeschlagen", nie nur Farbe). Bei `done`
 *          triggert es ein Board-Re-Fetch (Re-Key der BoardView via
 *          onBoardRefresh → frischer Mount beim nächsten Öffnen des Board-Reiters;
 *          KEIN erzwungener Tab-Wechsel — konsistent mit der S-205-Inline-Feedback-
 *          Doktrin, der „fertig"-Status bleibt sichtbar). Ein sichtbarer HINWEIS
 *          stellt klar, dass keine Live-Terminal-Ausgabe erscheint. Bestätigungs-
 *          dialog + Busy-Deaktivierung bleiben (fabric-intake-dialog AC8).
 *
 * drain-completion-report (S-255):
 *   AC7a — Die manuelle Inline-Status-Fläche (headless-manual-drain AC6, s.o.)
 *          zeigt bei `done` ZUSÄTZLICH „X erledigt / Y blockiert" + eine
 *          aufklappbare Liste (`<details>`) der erledigten/blockierten
 *          Story-IDs + Titel. Datenquelle: das `result.completed`/
 *          `result.blocked` aus derselben GET …/drain/:drainId-Poll-Antwort
 *          (DrainJobRegistry reicht die Felder seit S-255 durch, s.
 *          src/DrainJobRegistry.js). Der bestehende läuft/fertig/fehlgeschlagen-
 *          Status und das Board-Re-Fetch-Verhalten (AC6 oben) bleiben
 *          UNVERÄNDERT — rein additiv unterhalb davon gerendert.
 *
 * fabrik-arbeiten-layout (S-265):
 *   AC1 — Das dominante eingebettete Claude-Terminal-Pane ist aus dem Standard-
 *          Layout des „Arbeiten"-Reiters ENTFERNT (supersedes projekt-cockpit-
 *          navigation AC3-Formulierung „Terminal ... unverändert eingebettet",
 *          s.o.). Die Aktions-/Button-Spalte (Board abarbeiten, Idee, Neue
 *          Story) ist primärer Inhalt (`actionGrid`). (Status-Dashboard-Kachel
 *          entfernt — cockpit-declutter AC2, S-304.)
 *   AC2 — Checkbox „Terminal einblenden" (Default AUS, `showTerminal`-State)
 *          blendet am unteren Rand eine Terminal-Fläche mit `<Terminal>` ein/
 *          aus. Aus-/Einblenden mountet/unmountet NUR die Client-Komponente —
 *          die PTY-Session lebt serverseitig unverändert weiter (WsGateway/
 *          PtySessionRegistry sind vom WS-Close unabhängig, s. WsGateway.js
 *          `#onConnectionMulti` `ws.on('close', ...)` — entfernt nur die
 *          Output-Listener, killt keine Session). Beim erneuten Einblenden
 *          zeigt der serverseitige Scrollback-Replay den Verlauf. PtyManager/
 *          CommandService/WsGateway bleiben unverändert (AC5).
 *   AC3 — Die Button-Spalte ist gemäß dem in `docs/design.md` (Abschnitt
 *          „Arbeiten"-Layout) dokumentierten Designer-Vorschlag als
 *          responsives Karten-Grid (statt vertikaler Einzelspalte) neu
 *          angeordnet; Funktion/Verhalten jedes Buttons unverändert (gleiche
 *          Handler/Endpunkte).
 *   AC4/AC5 — s. A11y- und Security-Abschnitte unten.
 *
 * new-story-chat (S-227):
 *   AC1 — Die frühere „Änderung erfassen"-Box (IntakeDialog mode="change") ist
 *          ERSETZT durch eine „Neue Story"-Box (rechte Sidebar, Reiter
 *          „Arbeiten"): der Button öffnet `IdeaSpecifyChatModal` im
 *          „scratch"-Modus (Spezifizier-Chat von Grund auf, ohne Idee-Karte).
 *          Der IntakeDialog-change-Trigger (Öffnen/Schließen-State + Render)
 *          ist entfernt.
 *   AC6 — Bei Finalize `done` → onSpecified → Wechsel in den Board-Reiter
 *          (BoardView remountet → Board-Re-Fetch); neues Feature + To-Do-Story
 *          erscheinen sofort.
 *   AC7 — Fehler-/Randpfade (inline-Fehler, Retry, „Story anlegen" ohne
 *          readyToSpecify deaktiviert) leben im Overlay (IdeaSpecifyChatModal).
 *
 * ideen-inbox (S-199):
 *   AC4 — Sichtbarer Button „Idee" im Reiter „Arbeiten" (eigene Box, neben
 *          „Board abarbeiten") öffnet `IdeaCaptureModal` (eigene Komponente,
 *          Quick-Capture: Titel + optionaler Stichwort-Body → POST
 *          .../ideas). Token-frei — kein Agent, kein /flow-Trigger.
 *
 * ideen-inbox (S-200) / idea-specify-chat (S-218):
 *   Der frühere discuss-Tab-Sprung (onDiscussIdea-Callback, Wechsel in den
 *   Reiter „Arbeiten" nach POST .../discuss) ist SUPERSEDED durch
 *   idea-specify-chat (S-218): BoardView öffnet jetzt ein eigenes
 *   Chat-Overlay (`IdeaSpecifyChatModal`) direkt über dem Board — kein
 *   Tab-Wechsel mehr nötig. CockpitView reicht dafür keinen Callback mehr
 *   durch.
 *
 * reconcile-trigger (S-201) / reconcile-inline-feedback (S-205):
 *   SpecView erhält onNavigate weiterhin als Prop (Signatur-Kompatibilität),
 *   ruft sie aber NICHT mehr auf: der „Konzept/Spec nachziehen"-Button (siehe
 *   SpecView.jsx) bleibt seit S-205 nach erfolgreichem Auslösen (202) auf dem
 *   Spezifikation-Reiter (inline „Reconcile läuft…" → „Fertig" statt
 *   Navigate — überschreibt reconcile-trigger AC5).
 *
 * obsidian-sync-trigger (S-252):
 *   Der „Notizen-Stand abgleichen"-Button (SpecView.jsx, ObsidianSyncTrigger)
 *   wechselt nach erfolgreichem Auslösen (202) in den „Arbeiten"-Reiter, damit
 *   der Lauf live im Terminal sichtbar ist (AC6). **Präzisierung (Iteration
 *   2):** NICHT über das generische App-Level `onNavigate('factory')`
 *   (useHashRouter.navigate) — das würde den Hash von `#/factory/<repo>` auf
 *   das bare `#/factory` zurücksetzen und den Projekt-Kontext verlieren
 *   (`viewToHash('factory')` kennt kein Repo-Segment; Bug live im
 *   App-Integrationstest nachgewiesen). Stattdessen ein neuer, dedizierter
 *   `onShowArbeiten`-Callback (`handleShowArbeiten`, gespiegelt vom
 *   openSpec-/onShowBoard-Muster), der NUR den internen `activeTab`-State
 *   auf `'arbeiten'` umschaltet — CockpitView bleibt im selben Projekt-
 *   Kontext gemountet, kein Hash-Wechsel nötig. `onNavigate` selbst bleibt
 *   für SpecView weiterhin ungenutzte Signatur-Kompatibilität (wie schon bei
 *   reconcile-trigger/S-205).
 *
 * regression-panel (S-306):
 *   AC1/AC2 — Neue Karte „Regressionstests" im `actionGrid` (Position 5, nach
 *          „Neue Story"; die zu diesem Zeitpunkt noch bestehende Status-
 *          Dashboard-Kachel danach ist seither entfernt, cockpit-declutter AC2,
 *          S-304) — bindend aus docs/design.md
 *          Sektion „Fabrik-Panel Regressionstests" (D1–D16). Rahmen/Kopf/
 *          Kurzbeschreibung reusen `flowTriggerBox`/`flowTriggerHeader`/
 *          `flowTriggerHint` (keine neue Kartenvariante); zwei Buttons
 *          untereinander („ausführen" primär `btnFlowTrigger`, „definieren"
 *          sekundär Outline `btnRegressionDefine` — D7: eigener Token, an die
 *          Primär-Button-Höhe/-Breite angeglichen, NICHT die kompaktere
 *          `btnCancel`-Variante aus dem Confirm-Dialog-Button-Paar).
 *   AC3 — Klick-Ziele: die eigentlichen Dialoge ([[regression-run]] S-311,
 *          [[regression-define-dialog]] S-308) sind separate Items — der
 *          lokale Öffnen-State (`regressionRunOpen`/`regressionDefineOpen`)
 *          bleibt der Anknüpfungspunkt; `regressionDefineOpen` mountet SEIT
 *          S-308 `RegressionDefineDialog` (regression-define-dialog AC6-AC8,
 *          s. dortiger Modul-Kommentar); `regressionRunOpen` mountet SEIT
 *          S-311 `RegressionRunDialog` (regression-run AC4/AC6, Suite-Wahl
 *          Bereich/Verbund/Gesamt + Testobjekt-Anzeige + Kosten-/Ressourcen-
 *          Hinweis, s. dortiger Modul-Kommentar).
 *   AC4/AC6 — Inline-Statuszeile pollt `GET /api/projects/:slug/regression-runs`
 *          (jüngster Lauf zuerst, s. [[regression-result-store]] AC4) und
 *          bildet „kein Lauf"/„läuft"/„erfolgreich"/„fehlgeschlagen" ab
 *          (Icon+Text+Farbe gemeinsam, WCAG 2.1 AA). Der Store/Endpunkt ist
 *          Teil einer separaten, noch nicht abgeschlossenen Story (S-312) —
 *          404/Netzwerkfehler/unerwartete Shape degradieren defensiv auf
 *          „kein Lauf" (kein Karten-Crash, Edge-Case-Vorgabe der Spec).
 *   AC5 — Während `status:"running"` ist NUR „ausführen" gesperrt
 *          (Disabled-Token + `lockNotice`); „definieren" bleibt bedienbar.
 *   AC6/AC7 — natives `<button type="button">`, `minHeight:44`, Fokusring
 *          erhalten, `data-testid`-Präfix `regression-` (D16).
 *
 * A11y (WCAG 2.1 AA):
 *   - Reiter-Leiste als <nav role="tablist"> mit aria-selected.
 *   - Aktive Reiter-Panel mit role="tabpanel".
 *   - Sichtbarer Fokusring — KEIN outline:none.
 *   - Touch-Targets ≥ 44 px.
 *   - Button disabled via disabled-Attribut + Label (nie nur Farbe).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML.
 *   - Keine neuen Backend-Endpunkte in diesem Paket.
 *   - Keine Secrets im Bundle.
 *   - Bestätigungsdialog verhindert versehentliches Auslösen.
 *
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Terminal } from './Terminal.jsx';
import { BoardView } from './BoardView.jsx';
import { SpecView } from './SpecView.jsx';
import { IdeaCaptureModal } from './IdeaCaptureModal.jsx';
import { CostModeDriftNotice } from './CostModeDriftNotice.jsx';
import { IdeaSpecifyChatModal } from './IdeaSpecifyChatModal.jsx';
import { RegressionDefineDialog } from './RegressionDefineDialog.jsx';
import { RegressionRunDialog } from './RegressionRunDialog.jsx';
import { COST_MODES, COST_MODE_INFO } from './costMode.js';

/** @type {Array<{ id: string, label: string }>} */
const TABS = [
  { id: 'arbeiten', label: 'Arbeiten' },
  { id: 'board',    label: 'Studis-Kanban-Board' },
  { id: 'spec',     label: 'Spezifikation' },
];

/**
 * @param {{
 *   activeRepo: string,
 *   navigateFactory: (repo: string | null) => void,
 *   onNavigate: (view: string) => void,
 * }} props
 */
export function CockpitView({ activeRepo, navigateFactory, onNavigate: _onNavigate }) {
  const [activeTab, setActiveTab] = useState('arbeiten');

  // AC5: Pfad der im Spezifikation-Reiter direkt zu öffnenden Datei
  // (wird gesetzt wenn BoardView auf einen Spec-Bezug klickt)
  // SpecView remountet bei Tab-Wechsel — kein Reset nötig.
  const [pendingSpecPath, setPendingSpecPath] = useState(null);

  // AC5: Callback für BoardView — öffnet Spezifikation-Reiter + setzt Pfad
  const openSpec = useCallback((relPath) => {
    setPendingSpecPath(relPath);
    setActiveTab('spec');
  }, []);

  // obsidian-sync-trigger (S-252) AC6 — Präzisierung (Iteration 2, s. Spec):
  // schaltet NUR den internen Reiter auf „Arbeiten" um (kein Hash-/App-Level-
  // Navigate). Gespiegelt vom openSpec-/onShowBoard-Muster oben. Der
  // ursprüngliche Plan „onNavigate('factory')" (generisches App-Level-
  // useHashRouter.navigate) hätte den Hash von `#/factory/<repo>` auf das
  // bare `#/factory` zurückgesetzt (viewToHash('factory') kennt kein Repo-
  // Segment) — der Projekt-Kontext wäre verloren gegangen (Nutzer landet auf
  // der Repo-Übersicht statt im Cockpit). Da CockpitView bereits im richtigen
  // Projekt-Kontext gemountet ist, genügt ein lokaler Tab-Wechsel.
  //
  // obsidian-sync-trigger AC6 — Präzisierung (Iteration 3): der Tab-Wechsel
  // allein reicht NICHT — FactoryWorkspace zeigt das Terminal nur bei
  // showTerminal===true (Checkbox, Default AUS, fabrik-arbeiten-layout AC2/
  // S-265); ohne Auto-Einblenden landet der Nutzer im „Arbeiten"-Reiter, sieht
  // aber nur die Button-Spalte — der Lauf ist NICHT live sichtbar (AC6
  // verlangt das ausdrücklich). `autoShowTerminalToken` ist ein Zähler
  // (Muster `boardRefreshToken` oben) — FactoryWorkspace liest ihn NUR als
  // Lazy-Initial-Wert seines eigenen `showTerminal`-State beim (garantiert
  // frischen — s. conditional rendering unten) Mount und meldet den Konsum
  // sofort über `onAutoShowTerminalConsumed` zurück, worauf der Zähler wieder
  // auf 0 fällt. Das verhindert, dass ein SPÄTERER, unabhängiger manueller
  // Tab-Wechsel (weg von/zurück zu „Arbeiten") die Checkbox erneut automatisch
  // einschaltet — nur EIN Mount pro `onShowArbeiten()`-Aufruf profitiert
  // davon. Danach bleibt die Checkbox normal bedienbar (kein Lock) — kein
  // Konflikt mit fabrik-arbeiten-layout AC2, das nur den DEFAULT regelt.
  const [autoShowTerminalToken, setAutoShowTerminalToken] = useState(0);
  const handleShowArbeiten = useCallback(() => {
    setAutoShowTerminalToken((t) => t + 1);
    setActiveTab('arbeiten');
  }, []);
  const handleAutoShowTerminalConsumed = useCallback(() => {
    setAutoShowTerminalToken(0);
  }, []);

  // headless-manual-drain AC6: Board-Re-Fetch-Token. Ein abgeschlossener
  // Headless-Drain (kein Live-Terminal) hat das Board serverseitig verändert;
  // FactoryWorkspace ruft nach `done` `refreshBoard()` → der Token wechselt →
  // BoardView bekommt einen neuen `key` → frischer Mount + Board-Fetch beim
  // nächsten Öffnen des Board-Reiters (KEIN erzwungener Tab-Wechsel, damit der
  // „fertig"-Status neben dem Knopf sichtbar bleibt — S-205-Inline-Doktrin).
  const [boardRefreshToken, setBoardRefreshToken] = useState(0);
  const refreshBoard = useCallback(() => {
    setBoardRefreshToken((t) => t + 1);
  }, []);

  return (
    <div style={styles.cockpit}>
      {/* Cockpit header: project name + back link */}
      <div style={styles.cockpitHeader}>
        <button
          type="button"
          style={styles.backBtn}
          onClick={() => navigateFactory(null)}
          aria-label="Zurück zur Repo-Übersicht"
        >
          ← Übersicht
        </button>
        <span style={styles.projectName} aria-label={`Aktives Projekt: ${activeRepo}`}>
          {activeRepo}
        </span>
      </div>

      {/* Tab bar (AC3) */}
      <div
        role="tablist"
        aria-label="Cockpit-Reiter"
        style={styles.tabBar}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`cockpit-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`cockpit-panel-${tab.id}`}
            style={{
              ...styles.tabBtn,
              ...(activeTab === tab.id ? styles.tabBtnActive : {}),
            }}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels (AC3) — only the active tab is mounted */}

      {/* Arbeiten: bisheriger FactoryView-Inhalt unverändert eingebettet */}
      {activeTab === 'arbeiten' && (
        <div
          role="tabpanel"
          id="cockpit-panel-arbeiten"
          aria-labelledby="cockpit-tab-arbeiten"
          style={styles.tabPanel}
        >
          <FactoryWorkspace
            activeRepo={activeRepo}
            onShowBoard={() => setActiveTab('board')}
            onBoardRefresh={refreshBoard}
            autoShowTerminalToken={autoShowTerminalToken}
            onAutoShowTerminalConsumed={handleAutoShowTerminalConsumed}
          />
        </div>
      )}

      {/* Board: BoardView gefiltert auf das aktive Projekt (AC6 / S-113) */}
      {activeTab === 'board' && (
        <div
          role="tabpanel"
          id="cockpit-panel-board"
          aria-labelledby="cockpit-tab-board"
          style={styles.tabPanel}
        >
          <BoardView key={`board-${boardRefreshToken}`} lockedProject={activeRepo} onOpenSpec={openSpec} />
        </div>
      )}

      {/* Spezifikation: SpecView (AC4 — F-004, ersetzt Platzhalter) */}
      {activeTab === 'spec' && (
        <div
          role="tabpanel"
          id="cockpit-panel-spec"
          aria-labelledby="cockpit-tab-spec"
          style={styles.tabPanel}
        >
          <SpecView
            projectSlug={activeRepo}
            initialPath={pendingSpecPath}
            onNavigate={_onNavigate}
            onShowArbeiten={handleShowArbeiten}
          />
        </div>
      )}
    </div>
  );
}

// ── FactoryWorkspace ──────────────────────────────────────────────────────────

/** Session poll interval in ms (AC8). */
const SESSION_POLL_MS = 3_000;

/** Drain-Job-Status poll interval in ms (headless-manual-drain AC6). */
const DRAIN_POLL_MS = 2_500;

/** Regressionstest-Status poll interval in ms (regression-panel AC4/AC6). */
const REGRESSION_STATUS_POLL_MS = 5_000;

/**
 * FactoryWorkspace — the original FactoryView inner content: action cards +
 * optional Terminal pane. (TriggerPanel entfernt — cockpit-declutter AC1,
 * S-303; Status-Dashboard-Kachel entfernt — cockpit-declutter AC2, S-304.)
 *
 * Extended for AC4/S-111: passes project-scoped wsUrl to Terminal so commands
 * run in the active project session.
 *
 * Extended for autonome-board-abarbeitung AC2/S-119:
 * Adds „Board abarbeiten"-Knopf with confirmation dialog.
 * AC3: Hinweis that unclear items → Blocked (not guessing).
 *
 * Extended for fabric-intake-dialog AC8/S-136:
 * The „Board abarbeiten"-Knopf is AC8-compliant: polls GET /api/session
 * (state:"busy") to derive busy state and disables the button when a job is
 * running. After 202, calls onNavigate('factory') so the run is visible live
 * in the Terminal pane (consistent with IntakeDialog/AC4 pattern).
 *
 * Extended for taktgeber-nachtwaechter AC12/S-196:
 * The confirmed click now POSTs to /api/projects/:slug/drain (ProjectDrain-
 * Engine) instead of directly to /api/command with a single /agent-flow:flow
 * shot — draining the active project immediately (no night-window gate,
 * parallelism 1) until its board has no open drain-target story left. The
 * response contract (202 {drainId} → onNavigate('factory'); 409 → error) and
 * the busy-poll/disable behaviour (AC8 above) are unchanged.
 *
 * Extended for new-story-chat AC1/AC6/AC7 (S-227):
 * The former „Änderung erfassen"-Box (IntakeDialog mode="change") is REPLACED
 * by a „Neue Story"-Box that opens `IdeaSpecifyChatModal` in `mode="scratch"`
 * (Spezifizier-Chat von Grund auf, ohne Idee-Karte). On finalize `done` the
 * modal calls `onSpecified` → `onShowBoard()` switches to the board tab so the
 * new feature + To-Do-Story appear immediately (board re-fetch on mount).
 *
 * Extended for headless-manual-drain AC5/AC6 (S-224):
 * The „Board abarbeiten"-Knopf now runs the drain HEADLESS (ADR-017, no PTY /
 * no live terminal). A Cost-Mode dropdown sits right at the button (AC5) and is
 * sent as `{ costMode }` in the POST body. After 202 the panel POLLS
 * GET …/drain/:drainId and shows the status INLINE next to the button
 * („läuft…" | „fertig" | „fehlgeschlagen") instead of navigating to the terminal
 * pane (supersedes the AC8/AC12 onNavigate('factory') for this button). On
 * `done` it calls onBoardRefresh (board re-fetch) and a persistent hint makes
 * clear that no live terminal output appears.
 *
 * Extended for fabrik-arbeiten-layout AC1/AC2/AC3 (S-265):
 * The dominant embedded Terminal pane is REMOVED from the standard layout —
 * the action/button boxes (Board abarbeiten, Idee, Neue Story) render in a
 * responsive card grid (`actionGrid`) as the PRIMARY content (AC1/AC3).
 * (Status-Dashboard-Kachel entfernt — cockpit-declutter AC2, S-304.)
 * A „Terminal einblenden"-checkbox (default OFF,
 * `showTerminal` state) toggles a Terminal pane at the BOTTOM of the tab
 * (AC2) — showing the live output of the remaining interactive PTY commands
 * (adopt/preview/train/new-project + Kill). Hiding
 * the checkbox only unmounts the client `<Terminal>` component; the
 * server-side PTY session (PtySessionRegistry, via WsGateway) is unaffected
 * (a WS close only detaches the per-connection output listeners — the
 * session itself keeps running, see WsGateway.js `#onConnectionMulti`).
 * Re-showing replays the session's scrollback. No functional change to
 * PtyManager/CommandService/WsGateway (AC5).
 *
 * @param {{ activeRepo: string, fetchFn?: Function,
 *           onShowBoard?: () => void, onBoardRefresh?: () => void,
 *           autoShowTerminalToken?: number, onAutoShowTerminalConsumed?: () => void,
 *           pollInterval?: number, drainPollInterval?: number }} props
 *   fetchFn           — injectable for tests (default: globalThis.fetch)
 *   onShowBoard       — switch the cockpit to the board tab (new-story-chat AC6)
 *   onBoardRefresh    — trigger a BoardView re-fetch after a done drain (AC6)
 *   autoShowTerminalToken — (obsidian-sync-trigger AC6, S-252 Iteration 3)
 *                     counter; > 0 at mount time → Terminal-Checkbox startet
 *                     eingeschaltet statt dem sonstigen Default AUS (fabrik-
 *                     arbeiten-layout AC2 bleibt für alle anderen Mounts
 *                     unverändert). Nur als Lazy-Initial-Wert gelesen — kein
 *                     erzwungenes Wieder-Einschalten bei späteren Renders.
 *   onAutoShowTerminalConsumed — aufgerufen einmalig beim Mount, wenn
 *                     autoShowTerminalToken > 0 war (CockpitView setzt den
 *                     Zähler danach zurück, damit ein späterer, unabhängiger
 *                     Tab-Wechsel die Checkbox nicht erneut automatisch
 *                     einschaltet).
 *   pollInterval      — session poll interval in ms (default: SESSION_POLL_MS)
 *   drainPollInterval — drain-status poll interval in ms (default: DRAIN_POLL_MS)
 */
function FactoryWorkspace({
  activeRepo,
  fetchFn,
  onShowBoard,
  onBoardRefresh,
  autoShowTerminalToken = 0,
  onAutoShowTerminalConsumed,
  pollInterval = SESSION_POLL_MS,
  drainPollInterval = DRAIN_POLL_MS,
}) {
  // Build project-scoped WS URL: /ws/terminal?project=<encoded-path>
  // Terminal already resolves the protocol (ws/wss) from window.location —
  // we pass a full URL here so it is testable without DOM.
  const wsUrl = buildTerminalWsUrl(activeRepo);

  // fabrik-arbeiten-layout AC2: „Terminal einblenden"-Checkbox, Default AUS.
  // Toggling only mounts/unmounts the client <Terminal> — the server-side PTY
  // session is unaffected (see module-doc note above / WsGateway.js).
  // obsidian-sync-trigger AC6 (S-252, Iteration 3): startet eingeschaltet,
  // wenn dieser (garantiert frische, s. conditional rendering in CockpitView)
  // Mount von onShowArbeiten() ausgelöst wurde (autoShowTerminalToken > 0).
  const [showTerminal, setShowTerminal] = useState(() => autoShowTerminalToken > 0);

  // Konsum sofort nach dem Mount melden — CockpitView setzt den Zähler dann
  // auf 0 zurück, damit ein SPÄTERER, unabhängiger Tab-Wechsel (weg von/
  // zurück zu „Arbeiten") die Checkbox nicht erneut automatisch einschaltet.
  // Nur einmal pro Mount (bewusst leeres Dependency-Array).
  useEffect(() => {
    if (autoShowTerminalToken > 0) {
      onAutoShowTerminalConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Neue-Story-Chat state (new-story-chat AC1 — ersetzt „Änderung erfassen") ─
  /** Whether the „Neue Story"-Chat-Overlay (IdeaSpecifyChatModal, scratch) is open */
  const [newStoryOpen, setNewStoryOpen] = useState(false);
  const newStoryBtnRef = useRef(null);

  const handleNewStoryClose = useCallback(() => {
    setNewStoryOpen(false);
  }, []);

  // new-story-chat AC6: bei Finalize done → Board-Re-Fetch. Der Board-Reiter
  // remountet BoardView (frischer Fetch) → das neue Feature + die To-Do-Story
  // erscheinen sofort. (Der „kein Tab-Wechsel"-Zwang aus AC1 gilt der Chat-
  // Phase; nach dem Schließen bei done ist der Wechsel die AC6-Erfüllung.)
  const handleNewStorySpecified = useCallback(() => {
    setNewStoryOpen(false);
    if (onShowBoard) onShowBoard();
  }, [onShowBoard]);

  // ── Session busy state (AC8 fabric-intake-dialog) ─────────────────────────
  // Polls GET /api/session (state:"busy") to derive isRunning.
  // Used to disable the „Board abarbeiten"-Button (AC8).
  /** 'idle' | 'running' — derived from GET /api/session state */
  const [sessionRunState, setSessionRunState] = useState('idle');

  // Stable ref so poll effect doesn't re-register on every render
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      try {
        const res = await fetchFnRef.current('/api/session');
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) {
          setSessionRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // network error — keep current state
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  const isSessionBusy = sessionRunState === 'running';

  // ── Idee-Quick-Capture state (ideen-inbox AC4) — eigene Komponente (IdeaCaptureModal),
  // hier nur Trigger-Button + Open/Close-State (kein Agent, kein /flow-Trigger, token-frei).
  const [ideaModalOpen, setIdeaModalOpen] = useState(false);
  const ideaBtnRef = useRef(null);

  // ── Board-abarbeiten state (AC2 autonome-board-abarbeitung / AC8 fabric-intake-dialog) ──
  /** 'idle' | 'confirm' | 'starting' | 'started' | 'error' */
  const [flowState, setFlowState] = useState('idle');
  const [flowError, setFlowError] = useState(null);

  // ── Headless-Drain Cost-Mode + Job-Status (headless-manual-drain AC5/AC6) ──
  /** Cost-Mode am „Board abarbeiten"-Knopf (4-Wege, Default balanced) — AC5. */
  const [costMode, setCostMode] = useState('balanced');
  /** drainId der laufenden Headless-Drain-Session (aus der 202-Antwort) — AC6. */
  const [drainId, setDrainId] = useState(null);
  /** null | 'running' | 'done' | 'failed' — gepollter Drain-Job-Status (AC6). */
  const [drainStatus, setDrainStatus] = useState(null);
  /**
   * drain-completion-report AC7a: `{ completed: [{id,title}], blocked: [{id,title}] }`,
   * gesetzt aus `result.completed`/`result.blocked` sobald der Poll `done`
   * liefert; sonst `null` (kein Rendering). Fehlende/ungültige Felder werden
   * defensiv auf leere Arrays normalisiert (kein Crash).
   */
  const [drainReport, setDrainReport] = useState(null);

  // ── Regressionstests-Karte (regression-panel AC1–AC7) ──────────────────────
  // Klick-Ziele: die eigentlichen Dialoge ([[regression-run]] S-311,
  // [[regression-define-dialog]] S-308) sind separate Items — der lokale
  // Öffnen-State bleibt der Anknüpfungspunkt. Seit S-308 mountet
  // `regressionDefineOpen` den `RegressionDefineDialog`; seit S-311 mountet
  // `regressionRunOpen` den `RegressionRunDialog` (regression-run AC4/AC6).
  const [regressionRunOpen, setRegressionRunOpen] = useState(false);
  const [regressionDefineOpen, setRegressionDefineOpen] = useState(false);
  const regressionDefineBtnRef = useRef(null);
  const regressionRunBtnRef = useRef(null);
  /**
   * regression-define-dialog AC8/E1: der Wiedereinstiegs-Job wird ZUSAMMEN
   * mit dem Projekt gehalten, für das er gestartet wurde (Muster
   * `ObsidianImportSection` `ingestJob`/`ingestJobMatchesSelection`) — ein
   * Repo-Wechsel verwirft ihn (kein stilles Resume des falschen Jobs).
   */
  const [regressionDefineJob, setRegressionDefineJob] = useState(
    /** @type {{jobId:string, projectSlug:string}|null} */ (null),
  );
  useEffect(() => {
    setRegressionDefineJob((prev) => (prev && prev.projectSlug !== activeRepo ? null : prev));
  }, [activeRepo]);
  const regressionDefineJobMatchesSelection =
    Boolean(regressionDefineJob) && regressionDefineJob.projectSlug === activeRepo;
  /** null | 'running' | 'passed' | 'failed' — letzter Lauf-Zustand (AC4). */
  const [regressionLastStatus, setRegressionLastStatus] = useState(null);
  /** ISO-Zeitstempel des letzten Laufs (nur bei passed/failed relevant, D10). */
  const [regressionLastAt, setRegressionLastAt] = useState(null);

  const handleRegressionRunOpen = useCallback(() => {
    setRegressionRunOpen(true);
  }, []);
  const handleRegressionRunClose = useCallback(() => {
    setRegressionRunOpen(false);
  }, []);
  const handleRegressionDefineOpen = useCallback(() => {
    setRegressionDefineOpen(true);
  }, []);
  const handleRegressionDefineClose = useCallback(() => {
    setRegressionDefineOpen(false);
  }, []);
  // regression-run AC4/AC6 (S-311): nach erfolgreichem Start best-effort
  // sofort auf "running" schalten — der reguläre Poll (unten) übernimmt
  // danach ohnehin, das hier vermeidet nur die Wartezeit bis zum nächsten
  // Poll-Tick (kein neuer Anzeige-Ort, Nicht-Ziel dieser Story).
  const handleRegressionRunStarted = useCallback(() => {
    setRegressionLastStatus('running');
  }, []);

  // AC4/AC6: letzter Lauf-Zustand wird aus dem Ergebnis-Store gespeist
  // (GET /api/projects/:slug/regression-runs, jüngste zuerst — s.
  // regression-result-store.md AC4/Verträge). Der Store/Endpunkt ist Teil
  // einer separaten, noch nicht abgeschlossenen Story (S-312) — Polling
  // degradiert defensiv: 404/Netzwerkfehler/unbekannte Shape → „kein Lauf"
  // (kein Crash, Edge-Case-Vorgabe der Spec).
  useEffect(() => {
    let cancelled = false;
    const slug = activeRepo && typeof activeRepo === 'string' ? activeRepo.trim() : '';
    if (!slug) return undefined;
    const _fetch = fetchFnRef.current;

    // Repo-Wechsel: Zustand des VORHERIGEN Projekts sofort verwerfen, damit die
    // Karte nicht bis zum ersten erfolgreichen Poll für das NEUE Projekt einen
    // fremden Lauf-Zustand zeigt (Review-Finding Iteration 2).
    setRegressionLastStatus(null);
    setRegressionLastAt(null);

    async function pollRegressionStatus() {
      try {
        const res = await _fetch(`/api/projects/${encodeURIComponent(slug)}/regression-runs`);
        if (!res || !res.ok) {
          if (!cancelled) {
            setRegressionLastStatus(null);
            setRegressionLastAt(null);
          }
          return;
        }
        const json = await res.json();
        const runs = Array.isArray(json) ? json : Array.isArray(json?.runs) ? json.runs : [];
        const latest = runs[0];
        if (!cancelled) {
          if (latest && (latest.status === 'passed' || latest.status === 'failed' || latest.status === 'running')) {
            setRegressionLastStatus(latest.status);
            setRegressionLastAt(latest.startedAt ?? null);
          } else {
            setRegressionLastStatus(null);
            setRegressionLastAt(null);
          }
        }
      } catch {
        // Quelle nicht erreichbar → letzter bekannter Zustand bleibt stehen
        // (Edge-Case-Vorgabe); kein Crash.
      }
    }

    pollRegressionStatus();
    const timer = setInterval(pollRegressionStatus, REGRESSION_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRepo]);

  // ── Cost-Mode-Drift-Meldung (cost-mode-model-check AC4/AC5, S-228) ──
  // checkId aus der Drain-Antwort (`costModeCheckId`), falls der Dispatch eine
  // Drift erkannt hat → CostModeDriftNotice pollt den Status-Endpunkt und zeigt
  // die nicht-modale „Modell veraltet"-Meldung + Vorher/Nachher-Übersicht.
  // Additiv/nicht-blockierend: hat KEINEN Einfluss auf den Drain-Start.
  const [costModeCheckId, setCostModeCheckId] = useState(null);

  // AC8: button is disabled when a session is busy (global lock model).
  // Also disabled when local flowState is in-progress (confirm/starting).
  const isBoardBtnDisabled = isSessionBusy || flowState === 'starting';

  const handleFlowClick = useCallback(() => {
    setFlowState('confirm');
    setFlowError(null);
  }, []);

  const handleFlowCancel = useCallback(() => {
    setFlowState('idle');
    setFlowError(null);
  }, []);

  const handleFlowConfirm = useCallback(async () => {
    setFlowState('starting');
    setFlowError(null);
    // headless-manual-drain AC6: frischer Lauf → alten Drain-Status/Poll fallen
    // lassen (der Poll-Effect ist auf `drainId` gekeyt und stoppt beim Wechsel).
    setDrainId(null);
    setDrainStatus(null);
    setDrainReport(null); // drain-completion-report AC7a: alter Bericht fällt weg
    setCostModeCheckId(null);

    // taktgeber-nachtwaechter AC12 / headless-manual-drain AC1: der Knopf ruft die
    // ProjectDrain-Engine über POST /api/projects/:slug/drain auf — seit ADR-017
    // läuft der Drain HEADLESS (kein PTY, keine Live-Terminal-Ausgabe). CockpitView
    // wird nur mit aktivem Projekt gerendert (FactoryView), activeRepo ist hier
    // erwartungsgemäß immer gesetzt; defensiver Guard falls doch leer.
    const slug = activeRepo && typeof activeRepo === 'string' ? activeRepo.trim() : '';
    if (!slug) {
      setFlowState('error');
      setFlowError('Kein aktives Projekt — Drain kann nicht gestartet werden.');
      return;
    }

    const _fetch = fetchFnRef.current;
    let res;
    try {
      // headless-manual-drain AC5: Cost-Mode als JSON-Body mitschicken. `balanced`
      // (Default) wird serverseitig ohne Flag verarbeitet — wir senden es dennoch
      // explizit (Server lässt das Flag weg, AC5/AC3).
      res = await _fetch(`/api/projects/${encodeURIComponent(slug)}/drain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ costMode }),
      });
    } catch {
      setFlowState('error');
      setFlowError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // headless-manual-drain AC6: KEIN onNavigate('factory') mehr — der Drain
      // läuft headless (kein Live-Terminal). Stattdessen Drain-Status inline
      // pollen (s. Poll-Effect unten). Dialog schließen, Knopf optimistisch als
      // busy markieren (der Session-Poll bestätigt es).
      setFlowState('idle');
      setSessionRunState('running'); // optimistic update — poll will confirm
      // cost-mode-model-check AC4/AC5: bei Dispatch-Drift trägt die Antwort ein
      // `costModeCheckId` → nicht-modale Drift-Meldung + Vorher/Nachher-Übersicht
      // (CostModeDriftNotice). Zusätzlich trägt die Antwort die `drainId` für den
      // Status-Poll (AC6). Best-effort: ein fehlendes/unlesbares Feld unterdrückt
      // nur die jeweilige Anzeige (kein Fehler — der Drain läuft ohnehin bereits).
      try {
        const body = await res.json();
        if (body && typeof body.costModeCheckId === 'string' && body.costModeCheckId) {
          setCostModeCheckId(body.costModeCheckId);
        }
        if (body && typeof body.drainId === 'string' && body.drainId) {
          setDrainStatus('running');
          setDrainId(body.drainId); // startet den Poll-Effect (AC6)
        }
      } catch {
        // best-effort — kein Status-Poll/keine Drift-Meldung, kein Crash
      }
      return;
    }
    if (res.status === 409) {
      // Job already running — reflect session state
      setSessionRunState('running');
      setFlowState('error');
      setFlowError('Ein Job läuft bereits — bitte warten.');
      return;
    }
    setFlowState('error');
    setFlowError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [activeRepo, costMode]);

  // ── Drain-Job-Status-Poll (headless-manual-drain AC6) ─────────────────────
  // Nach 202 pollt das Panel GET …/drain/:drainId, bis der Job nicht mehr
  // `running` ist. `done` → Board-Re-Fetch (onBoardRefresh) + „fertig" inline;
  // `failed` → „fehlgeschlagen" inline. Poll-Robustheit (coder-Lesson
  // 2026-07-01): ein Nicht-200 (z.B. 404 nach Registry-Verlust/Neustart) ODER
  // ein 200 mit unbekanntem/fehlendem Status wird NICHT wie „noch running"
  // behandelt — der Loop endet dann als `failed` statt endlos still zu pollen.
  useEffect(() => {
    if (!drainId) return undefined;
    const slug = activeRepo && typeof activeRepo === 'string' ? activeRepo.trim() : '';
    if (!slug) return undefined;

    let cancelled = false;
    let timer = null;

    async function pollDrain() {
      let res;
      try {
        res = await fetchFnRef.current(
          `/api/projects/${encodeURIComponent(slug)}/drain/${encodeURIComponent(drainId)}`,
        );
      } catch {
        // Netzwerkfehler — später erneut versuchen (kein Endzustand).
        if (!cancelled) timer = setTimeout(pollDrain, drainPollInterval);
        return;
      }
      if (cancelled) return;

      if (res.status !== 200) {
        // 404 (unbekannte drainId, z.B. nach Neustart) o.ä. → Endzustand, NICHT
        // endlos weiterpollen (coder-Lesson: 404 ≠ „noch running").
        setDrainStatus('failed');
        setSessionRunState('idle');
        return;
      }

      let data;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (cancelled) return;

      const status = data && typeof data.status === 'string' ? data.status : null;
      if (status === 'running') {
        timer = setTimeout(pollDrain, drainPollInterval);
        return;
      }
      if (status === 'done') {
        setDrainStatus('done');
        setSessionRunState('idle');
        // drain-completion-report AC7a: completed/blocked aus derselben
        // Poll-Antwort übernehmen (defensiv normalisiert, kein Crash bei
        // fehlendem/ungültigem result — dann 0/0 statt Absturz).
        const result = data && typeof data.result === 'object' && data.result !== null ? data.result : {};
        setDrainReport({
          completed: Array.isArray(result.completed) ? result.completed : [],
          blocked: Array.isArray(result.blocked) ? result.blocked : [],
        });
        if (onBoardRefresh) onBoardRefresh(); // Board-Re-Fetch (AC6)
        return;
      }
      // 'failed' ODER unbekannter/fehlender Status im 200 → Endzustand failed.
      setDrainStatus('failed');
      setSessionRunState('idle');
    }

    pollDrain();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [drainId, activeRepo, drainPollInterval, onBoardRefresh]);

  return (
    <div style={styles.factory}>
      {/* fabrik-arbeiten-layout AC1/AC3: Aktions-/Button-Spalte als responsives
          Karten-Grid — primärer Inhalt (kein dominantes Terminal-Pane mehr). */}
      <div style={styles.actionArea}>
        <div style={styles.actionGrid}>
        {/* AC2 (autonome-board-abarbeitung): Board-abarbeiten Knopf */}
        <div style={styles.flowTriggerBox}>
          <div style={styles.flowTriggerHeader}>Board abarbeiten</div>
          <p style={styles.flowTriggerHint}>
            Startet <code style={styles.code}>/agent-flow:flow</code> headless im Hintergrund.
            Offene Fragen oder Spec-Lücken → Story auf <strong>Blocked</strong> (statt raten).
          </p>

          {/* headless-manual-drain AC6: Hinweis — der Lauf ist headless, es gibt
              KEINE Live-Terminal-Ausgabe (Erwartungsmanagement). */}
          <div style={styles.noLiveHint} data-testid="drain-no-live-terminal-hint">
            ℹ Läuft <strong>headless</strong> im Hintergrund — es erscheint{' '}
            <strong>keine</strong> Live-Ausgabe im Terminal. Fortschritt siehst du hier
            am Status und auf dem Board.
          </div>

          {/* headless-manual-drain AC5: Cost-Mode-Dropdown direkt am Knopf
              (geteilt via costMode.js — 4-Wege, Default balanced). Wird als
              `{ costMode }` an POST …/drain gesendet. */}
          <label style={styles.costLabel} htmlFor="drain-cost-mode">
            Cost-Mode <span style={styles.costOptional}>(Token-Hebel)</span>
          </label>
          <select
            id="drain-cost-mode"
            style={styles.costSelect}
            value={costMode}
            disabled={isBoardBtnDisabled}
            aria-disabled={isBoardBtnDisabled}
            onChange={(e) => setCostMode(e.target.value)}
            data-testid="drain-cost-mode-select"
          >
            {COST_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div style={styles.costInfo} aria-live="polite" data-testid="drain-cost-info">
            <span>{COST_MODE_INFO[costMode].models} · {COST_MODE_INFO[costMode].price} /MTok</span>
            <span style={styles.costDisclaimer}>
              ⚠ Abo-Betrieb — keine Direktkosten pro Token; Werte nur relative Tier-Schwere.
            </span>
          </div>

          {flowState === 'idle' && (
            <button
              type="button"
              style={isBoardBtnDisabled ? styles.btnFlowTriggerDisabled : styles.btnFlowTrigger}
              disabled={isBoardBtnDisabled}
              aria-disabled={isBoardBtnDisabled}
              onClick={isBoardBtnDisabled ? undefined : handleFlowClick}
              aria-label={
                isSessionBusy
                  ? 'Board abarbeiten — gesperrt (Job läuft)'
                  : 'Board abarbeiten starten — öffnet Bestätigungsdialog'
              }
              data-testid="flow-board-btn"
            >
              {isSessionBusy ? 'Board abarbeiten — gesperrt' : 'Board abarbeiten'}
            </button>
          )}

          {/* AC8 (fabric-intake-dialog): lock notice when session busy */}
          {isSessionBusy && flowState === 'idle' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.lockNotice}
              data-testid="flow-board-lock-notice"
            >
              Ein Job läuft — Trigger gesperrt.
            </div>
          )}

          {/* AC2: Bestätigungsdialog — verhindert versehentlichen Start */}
          {flowState === 'confirm' && (
            <div
              role="dialog"
              aria-modal="false"
              aria-label="Board abarbeiten bestätigen"
              style={styles.confirmBox}
              data-testid="flow-confirm-dialog"
            >
              <p style={styles.confirmText}>
                Startet die autonome Abarbeitung des Boards: ein Agent schreibt Code
                und legt PRs an. Fortfahren?
              </p>
              <div style={styles.confirmBtns}>
                <button
                  type="button"
                  style={styles.btnConfirm}
                  onClick={handleFlowConfirm}
                  aria-label="Bestätigen — Board-Abarbeitung starten"
                  data-testid="flow-confirm-yes"
                >
                  Starten
                </button>
                <button
                  type="button"
                  style={styles.btnCancel}
                  onClick={handleFlowCancel}
                  aria-label="Abbrechen — kein Start"
                  data-testid="flow-confirm-no"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}

          {flowState === 'starting' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.flowStatus}
              data-testid="flow-starting"
            >
              Starte…
            </div>
          )}

          {/* 'started' state no longer shown — AC8: after 202 we navigate to terminal pane */}

          {flowState === 'error' && (
            <div
              role="alert"
              style={styles.flowStatusError}
              data-testid="flow-error"
            >
              {flowError}
              <button
                type="button"
                style={styles.btnFlowReset}
                onClick={() => setFlowState('idle')}
                aria-label="Fehlerstatus zurücksetzen"
                data-testid="flow-error-reset"
              >
                Zurücksetzen
              </button>
            </div>
          )}

          {/* headless-manual-drain AC6: gepollter Drain-Job-Status INLINE neben
              dem Knopf. Bedeutung immer TEXTLICH (nicht nur Farbe, WCAG 2.1 AA);
              `failed` als role=alert, sonst role=status. */}
          {drainStatus && (
            <div
              role={drainStatus === 'failed' ? 'alert' : 'status'}
              aria-live="polite"
              style={
                drainStatus === 'done'
                  ? styles.drainStatusDone
                  : drainStatus === 'failed'
                    ? styles.drainStatusFailed
                    : styles.drainStatusRunning
              }
              data-testid="drain-job-status"
              data-status={drainStatus}
            >
              {drainStatus === 'running' && '⏳ Drain läuft… (headless, kein Terminal-Output)'}
              {drainStatus === 'done' && '✓ Drain fertig — Board aktualisiert.'}
              {drainStatus === 'failed' && '✗ Drain fehlgeschlagen — siehe Server-Log/Board.'}
            </div>
          )}

          {/* drain-completion-report AC7a: kompakter Abschlussbericht bei `done`,
              additiv unterhalb des bestehenden Status — läuft/fertig/fehlgeschlagen
              und Board-Re-Fetch (oben) bleiben unverändert. Zahlen/Status IMMER
              textlich (WCAG 2.1 AA), aufklappbare Story-Liste via <details>. */}
          {drainStatus === 'done' && drainReport && (
            <div style={styles.drainReportBox} data-testid="drain-report-summary">
              <span>
                {drainReport.completed.length} erledigt / {drainReport.blocked.length} blockiert
              </span>
              {(drainReport.completed.length > 0 || drainReport.blocked.length > 0) && (
                <details style={styles.drainReportDetails} data-testid="drain-report-details">
                  <summary style={styles.drainReportSummary}>Story-Liste anzeigen</summary>
                  <ul style={styles.drainReportList}>
                    {drainReport.completed.map((s) => (
                      <li key={`done-${s?.id}`}>✓ {s?.id} — {s?.title || '—'}</li>
                    ))}
                    {drainReport.blocked.map((s) => (
                      <li key={`blocked-${s?.id}`}>✗ {s?.id} — {s?.title || '—'}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* cost-mode-model-check AC4/AC5 (S-228): nicht-modale Drift-Meldung +
              Vorher/Nachher-Übersicht, wenn der Dispatch eine Modell-Drift erkannt
              hat (checkId aus der Drain-Antwort). Rein additiv — blockiert nichts. */}
          {costModeCheckId && (
            <CostModeDriftNotice checkId={costModeCheckId} fetchFn={fetchFn} />
          )}
        </div>

        {/* AC4 (ideen-inbox): „Idee"-Button — Quick-Capture-Modal (IdeaCaptureModal.jsx) */}
        <div style={styles.flowTriggerBox}>
          <div style={styles.flowTriggerHeader}>Idee</div>
          <p style={styles.flowTriggerHint}>
            Stichworte in Sekunden ins Board werfen — landet in der Spalte „Idee".
          </p>
          <button
            type="button"
            ref={ideaBtnRef}
            style={styles.btnFlowTrigger}
            onClick={() => setIdeaModalOpen(true)}
            aria-label="Idee erfassen — öffnet Quick-Capture-Modal"
            data-testid="idea-capture-btn"
          >
            Idee
          </button>
        </div>

        {/* Neue-Story-Trigger (new-story-chat AC1 — ersetzt „Änderung erfassen"):
            öffnet den Spezifizier-Chat von Grund auf (IdeaSpecifyChatModal,
            scratch-Modus). Der frühere IntakeDialog mode="change"-Trigger
            (Öffnen/Schließen-State + Render) ist entfernt. */}
        <div style={styles.intakeTriggerBox}>
          <div style={styles.flowTriggerHeader}>Neue Story</div>
          <p style={styles.flowTriggerHint}>
            Neue Story von Grund auf spezifizieren — Chat mit Claude, am Ende legt{' '}
            <code style={styles.code}>/agent-flow:requirement</code> Feature + Story an.
          </p>
          <button
            type="button"
            ref={newStoryBtnRef}
            style={styles.btnIntakeTrigger}
            onClick={() => setNewStoryOpen(true)}
            aria-label="Neue Story spezifizieren — öffnet den Chat"
            data-testid="new-story-btn"
          >
            Neue Story
          </button>
        </div>

        {/* regression-panel AC1/D1: Regressionstests-Karte — Position 5 (nach
            „Neue Story"; die zu diesem Zeitpunkt noch bestehende Status-
            Dashboard-Kachel danach ist seither entfernt, cockpit-declutter
            AC2, S-304). Zwei Buttons untereinander;
            die Klick-Ziele (Ausführen-/Definier-Dialog) sind separate,
            noch nicht abgeschlossene Stories (S-311/S-308) — hier nur der
            Öffnen-State als Anknüpfungspunkt. */}
        <div
          style={styles.flowTriggerBox}
          data-testid="regression-card"
          data-run-dialog-open={regressionRunOpen}
          data-define-dialog-open={regressionDefineOpen}
        >
          <div style={styles.flowTriggerHeader}>Regressionstests</div>
          <p style={styles.flowTriggerHint}>
            Führt die hinterlegte Regressionstest-Suite aus bzw. öffnet ihre Definition.
          </p>

          <button
            type="button"
            ref={regressionRunBtnRef}
            style={
              regressionLastStatus === 'running'
                ? styles.btnFlowTriggerDisabled
                : styles.btnFlowTrigger
            }
            disabled={regressionLastStatus === 'running'}
            aria-disabled={regressionLastStatus === 'running'}
            onClick={regressionLastStatus === 'running' ? undefined : handleRegressionRunOpen}
            aria-label={
              regressionLastStatus === 'running'
                ? 'Regressionstest ausführen — gesperrt (Lauf aktiv)'
                : 'Regressionstest ausführen — startet die Regressionstest-Suite'
            }
            data-testid="regression-run-btn"
          >
            Regressionstest ausführen
          </button>

          <button
            type="button"
            ref={regressionDefineBtnRef}
            style={styles.btnRegressionDefine}
            onClick={handleRegressionDefineOpen}
            aria-label="Regressionstest definieren — öffnet die Definitionsansicht"
            data-testid="regression-define-btn"
          >
            Regressionstest definieren
          </button>

          {/* AC5/D11: während eines aktiven Laufs ist NUR „ausführen" gesperrt.
              DOM-Reihenfolge D3: nach BEIDEN Buttons, vor der Statuszeile. */}
          {regressionLastStatus === 'running' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.lockNotice}
              data-testid="regression-lock-notice"
            >
              Ein Regressionstest läuft — Ausführen gesperrt.
            </div>
          )}

          {/* AC4/D9: Inline-Statuszeile zum letzten Lauf. Icon + Text + Farbe
              immer gemeinsam (nie Farbe allein, WCAG 2.1 AA). */}
          {regressionLastStatus === 'running' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.drainStatusRunning}
              data-testid="regression-status"
              data-status="running"
            >
              ⏳ Regressionstest läuft…
            </div>
          )}
          {regressionLastStatus === 'passed' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.drainStatusDone}
              data-testid="regression-status"
              data-status="passed"
            >
              ✓ Erfolgreich — {formatRegressionTimestamp(regressionLastAt)}
            </div>
          )}
          {regressionLastStatus === 'failed' && (
            <div
              role="alert"
              style={styles.drainStatusFailed}
              data-testid="regression-status"
              data-status="failed"
            >
              ✗ Fehlgeschlagen — {formatRegressionTimestamp(regressionLastAt)}
            </div>
          )}
          {!regressionLastStatus && (
            <p style={styles.flowTriggerHint} data-testid="regression-status" data-status="none">
              Noch kein Regressionstest gelaufen.
            </p>
          )}
        </div>

        </div>
      </div>

      {/* fabrik-arbeiten-layout AC2: Checkbox „Terminal einblenden" (Default AUS) —
          Kontrollzeile am unteren Rand, IMMER sichtbar (auch bei scrollendem
          Aktions-Grid darüber). Touch-Target ≥44px, Fokusring erhalten. */}
      <div style={styles.terminalToggleBar}>
        <label style={styles.terminalToggleLabel} htmlFor="show-terminal-checkbox">
          <input
            id="show-terminal-checkbox"
            type="checkbox"
            checked={showTerminal}
            onChange={(e) => setShowTerminal(e.target.checked)}
            style={styles.terminalCheckbox}
            data-testid="show-terminal-checkbox"
          />
          Terminal einblenden
        </label>
      </div>

      {/* fabrik-arbeiten-layout AC2: Terminal-Fläche am unteren Rand, nur bei
          aktivierter Checkbox gemountet. Unmount killt die serverseitige PTY-
          Session NICHT (s. Modul-Doku oben) — nur die Client-Ansicht verschwindet. */}
      {showTerminal && (
        <main style={styles.terminalBottomPane} aria-label="Terminal">
          <Terminal wsUrl={wsUrl} />
        </main>
      )}

      {/* AC4 (ideen-inbox): Quick-Capture-Modal, eigene Komponente */}
      {ideaModalOpen && (
        <IdeaCaptureModal
          projectSlug={activeRepo}
          onClose={() => setIdeaModalOpen(false)}
          triggerRef={ideaBtnRef}
          fetchFn={fetchFn}
        />
      )}

      {/* new-story-chat AC1/AC6/AC7: „Neue Story"-Chat-Overlay (scratch-Modus) */}
      {newStoryOpen && (
        <IdeaSpecifyChatModal
          mode="scratch"
          projectSlug={activeRepo}
          onClose={handleNewStoryClose}
          onSpecified={handleNewStorySpecified}
          triggerRef={newStoryBtnRef}
          fetchFn={fetchFn}
        />
      )}

      {/* regression-define-dialog AC6/AC7/AC8: Definier-Dialog + Redaktions-Overlay */}
      {regressionDefineOpen && (
        <RegressionDefineDialog
          projectSlug={activeRepo}
          onClose={handleRegressionDefineClose}
          triggerRef={regressionDefineBtnRef}
          fetchFn={fetchFn}
          initialJobId={regressionDefineJobMatchesSelection ? regressionDefineJob.jobId : null}
          onJobStarted={(jobId) => setRegressionDefineJob({ jobId, projectSlug: activeRepo })}
          onJobEnded={() => setRegressionDefineJob(null)}
        />
      )}

      {/* regression-run AC4/AC6 (S-311): Ausführen-Dialog — Suite-Wahl
          (Bereich/Verbund/Gesamt), Testobjekt-Anzeige, Kosten-/Ressourcen-Hinweis. */}
      {regressionRunOpen && (
        <RegressionRunDialog
          projectSlug={activeRepo}
          onClose={handleRegressionRunClose}
          triggerRef={regressionRunBtnRef}
          fetchFn={fetchFn}
          onRunStarted={handleRegressionRunStarted}
        />
      )}
    </div>
  );
}

/**
 * Build a project-scoped WS URL for the terminal.
 * When activeRepo is provided, appends ?project=<encoded-path>.
 * Falls back to undefined (Terminal uses its default global session) when no
 * project is active or when running outside a browser context.
 *
 * Returns a full absolute WS URL:
 *   ws://host/ws/terminal?project=<encoded>   (http origin)
 *   wss://host/ws/terminal?project=<encoded>  (https origin)
 *
 * @param {string|null|undefined} activeRepo  Absolute project path or name
 * @returns {string|undefined}  Full absolute WS URL, or undefined (Terminal uses its default)
 */
function buildTerminalWsUrl(activeRepo) {
  if (!activeRepo || typeof window === 'undefined') return undefined; // SSR-safe no-op
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws/terminal`;
  return `${base}?project=${encodeURIComponent(activeRepo)}`;
}

/**
 * regression-panel D10: Zeitstempel-Format für die Inline-Statuszeile,
 * identisch zum bestehenden Muster in BackupSection.jsx.
 * @param {string|number|null|undefined} ts
 * @returns {string} formatiertes Datum, oder '—' falls ts fehlt/ungültig.
 */
function formatRegressionTimestamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' });
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  cockpit: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: '#1a1a1a',
  },

  cockpitHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 16px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },

  backBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },

  projectName: {
    fontSize: 14,
    fontWeight: 700,
    color: '#e5e7eb',
    fontFamily: 'monospace',
  },

  tabBar: {
    display: 'flex',
    gap: 2,
    padding: '6px 16px 0',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },

  tabBtn: {
    background: 'transparent',
    borderTop: '1px solid transparent',
    borderRight: '1px solid transparent',
    borderBottom: '1px solid transparent',
    borderLeft: '1px solid transparent',
    color: '#9ca3af',
    fontSize: 13,
    cursor: 'pointer',
    padding: '8px 16px',
    borderRadius: '4px 4px 0 0',
    minHeight: 44,
    minWidth: 80,
    // Focus ring preserved (no outline:none)
  },

  tabBtnActive: {
    color: '#e5e7eb',
    background: '#1a1a1a',
    borderTopColor: '#2a2a2a',
    borderRightColor: '#2a2a2a',
    borderBottomColor: '#1a1a1a', // blends with panel background
    borderLeftColor: '#2a2a2a',
  },

  tabPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },

  placeholderPanel: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  placeholderText: {
    // #9ca3af on #1a1a1a ≈ 5.1:1 contrast — WCAG AA compliant for 14px text
    color: '#9ca3af',
    fontSize: 15,
    fontStyle: 'italic',
    margin: 0,
  },

  // ── FactoryWorkspace inner layout (fabrik-arbeiten-layout AC1–AC3, S-265) ──
  // Designer-Vorschlag dokumentiert in docs/design.md „Arbeiten"-Layout:
  // Aktions-Karten-Grid (primär, scrollbar) oben + Terminal-Toggle-Leiste +
  // optionale Terminal-Fläche unten (statt vormals dominantem Terminal-Pane
  // links + vertikaler Sidebar-Spalte rechts).

  factory: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: '#1a1a1a',
  },

  // AC1/AC3: primärer, scrollbarer Bereich für das Aktions-Karten-Grid.
  actionArea: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
  },

  // AC3: responsives Karten-Grid — wrapped je nach Breite (Desktop mehrspaltig,
  // < ~768 px durch flexWrap natürlich einspaltig, s. design.md).
  actionGrid: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    gap: 16,
    padding: 16,
  },

  // AC2: Kontrollzeile mit der „Terminal einblenden"-Checkbox, unterer Rand,
  // immer sichtbar (flexShrink:0 — bleibt unterhalb des scrollenden Grids).
  terminalToggleBar: {
    flexShrink: 0,
    borderTop: '1px solid #2a2a2a',
    background: '#0d0d0d',
    padding: '4px 16px',
  },

  terminalToggleLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 44,
    fontSize: 13,
    color: '#d1d5db',
    cursor: 'pointer',
    // Focus ring preserved (no outline:none) — native checkbox focus ring.
  },

  terminalCheckbox: {
    width: 18,
    height: 18,
    cursor: 'pointer',
  },

  // AC2: Terminal-Fläche am unteren Rand — feste Höhe statt dominant/full-height.
  terminalBottomPane: {
    flexShrink: 0,
    height: 280,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    borderTop: '1px solid #2a2a2a',
  },

  // ── Intake-Dialog trigger box (AC1 fabric-intake-dialog) ────────────────
  // AC3 fabrik-arbeiten-layout: als Karte im actionGrid (voller Rahmen statt
  // nur borderBottom — Funktion/Verhalten unverändert, nur Optik).

  intakeTriggerBox: {
    padding: '12px 16px',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    minWidth: 240,
    maxWidth: 300,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  btnIntakeTrigger: {
    background: '#065f46',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  // ── Board abarbeiten box (AC2 autonome-board-abarbeitung) ─────────────────
  // AC3 fabrik-arbeiten-layout: als Karte im actionGrid (voller Rahmen statt
  // nur borderBottom — Funktion/Verhalten unverändert, nur Optik).

  flowTriggerBox: {
    padding: '12px 16px',
    background: '#0d0d0d',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    minWidth: 240,
    maxWidth: 300,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  flowTriggerHeader: {
    fontSize: 12,
    fontWeight: 700,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  flowTriggerHint: {
    fontSize: 11,
    color: '#6b7280',
    margin: 0,
    lineHeight: 1.5,
  },

  code: {
    fontFamily: 'monospace',
    background: '#1a1a1a',
    padding: '0 3px',
    borderRadius: 2,
    fontSize: 10,
    color: '#93c5fd',
  },

  btnFlowTrigger: {
    background: '#1d4ed8',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  // AC8 (fabric-intake-dialog): disabled state when session busy
  btnFlowTriggerDisabled: {
    background: '#1e293b',
    color: '#64748b',
    border: 'none',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },

  // AC8: lock notice text when session busy (supplements disabled button — not color alone)
  lockNotice: {
    fontSize: 11,
    color: '#fbbf24',
    fontStyle: 'italic',
  },

  // regression-panel D7: sekundärer Standalone-Button „Regressionstest
  // definieren" — Outline-Familie wie btnCancel, aber an die Primär-Button-
  // Höhe/-Breite angeglichen (padding/fontSize wie btnFlowTrigger), NICHT
  // die kompaktere btnCancel-Variante aus dem Confirm-Dialog-Button-Paar.
  btnRegressionDefine: {
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '8px 12px',
    fontSize: 13,
    fontWeight: 400,
    cursor: 'pointer',
    minHeight: 44,
  },

  confirmBox: {
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  confirmText: {
    fontSize: 12,
    color: '#d1d5db',
    margin: 0,
    lineHeight: 1.5,
  },

  confirmBtns: {
    display: 'flex',
    gap: 8,
  },

  btnConfirm: {
    flex: 1,
    background: '#15803d',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
  },

  btnCancel: {
    flex: 1,
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 44,
  },

  btnFlowReset: {
    background: 'transparent',
    border: '1px solid #374151',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    marginTop: 4,
    minHeight: 44,
    display: 'block',
  },

  // ── headless-manual-drain AC6: Kein-Live-Terminal-Hinweis ─────────────────
  noLiveHint: {
    // #93a3b8 on #0d0d0d ≈ 6.5:1 — WCAG AA for 11px text
    fontSize: 11,
    color: '#93a3b8',
    background: '#0f1620',
    border: '1px solid #1e293b',
    borderRadius: 4,
    padding: '6px 8px',
    lineHeight: 1.5,
  },

  // ── headless-manual-drain AC5: Cost-Mode am Knopf ──────────────────────────
  costLabel: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },

  costOptional: {
    fontSize: 11,
    color: '#9ca3af',
  },

  costSelect: {
    background: '#1e1e1e',
    color: '#d4d4d4',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '6px 8px',
    fontSize: 13,
    width: '100%',
    boxSizing: 'border-box',
    cursor: 'pointer',
    minHeight: 44,
  },

  costInfo: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    marginTop: 2,
    fontSize: 11,
    color: '#9ca3af',
  },

  costDisclaimer: {
    fontSize: 10,
    color: '#93a3b8',
    fontStyle: 'italic',
  },

  // ── headless-manual-drain AC6: Drain-Job-Status inline ────────────────────
  drainStatusRunning: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  drainStatusDone: {
    fontSize: 12,
    color: '#86efac',
    fontWeight: 600,
  },

  drainStatusFailed: {
    fontSize: 12,
    color: '#f87171',
    fontWeight: 600,
  },

  // ── drain-completion-report AC7a: Abschlussbericht inline (manueller Drain) ──
  drainReportBox: {
    fontSize: 12,
    // #d1d5db on #0d0d0d ≈ 11.9:1 — WCAG AA
    color: '#d1d5db',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

  drainReportDetails: {
    fontSize: 11,
  },

  drainReportSummary: {
    // #93c5fd on #0d0d0d ≈ 8.9:1 — WCAG AA
    color: '#93c5fd',
    cursor: 'pointer',
    minHeight: 24,
  },

  drainReportList: {
    margin: '4px 0 0',
    paddingLeft: 18,
    color: '#9ca3af',
    lineHeight: 1.6,
  },

  flowStatus: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  flowStatusOk: {
    fontSize: 12,
    color: '#86efac',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

  flowStatusError: {
    fontSize: 12,
    color: '#f87171',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

};
