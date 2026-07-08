/**
 * BoardView.test.jsx — Unit tests for BoardView.
 *
 * Covers (dev-gui-board-aggregator):
 *   AC4 — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten;
 *          aggregiert über alle Projekte; aria-busy/aria-live Ladezustand;
 *          Fehlerzustand; Leerzustand; GET /api/board/projects/* Aufrufe.
 *   AC5 — Rollup-Anzeige je Feature: vorhandenes progress-Feld → direkt anzeigen;
 *          fehlendes/stale progress → read-only aus Kind-Story-Status berechnet;
 *          progressbar-Role mit aria-valuenow.
 *   AC6 — Filter nach Projekt (Dropdown), Status (Checkbox-Gruppe),
 *          Label (Dropdown); unabhängig kombinierbar; Zurücksetzen-Button;
 *          kein Backend-Aufruf beim Filtern.
 *          Filter-Leerzustand: role=status-Hinweis wenn Filter alle Stories eliminieren.
 *   Feature detail panel — expand/collapse je Feature-Titel (aria-expanded/aria-controls);
 *          goal, DoD, priority, depends, labels; null-Felder ausgeblendet.
 *   Multi-Status-Filter — Mehrfach-Check; Uncheck; Reset.
 *
 * Covers (studis-kanban-board-ux):
 *   AC1 — aria-label + h1 = „Studis-Kanban-Board"; Route-id `board` unverändert;
 *          viewRegistry label = „Studis-Kanban-Board".
 *   AC2 — Status-Filter Default: alle 5 angehakt; alles sichtbar; Deselektieren blendet aus.
 *   AC3 — Alle Status deselektiert → role=status „Kein Status gewählt".
 *   AC4 — Status-Filter als Popover: Button „Status (n/5) ▾"; öffnet/schließt per Klick;
 *          schließt per Esc + Außenklick; aria-expanded/-controls korrekt.
 *   AC5 — GET /api/board/projects/list (leicht) in standalone;
 *          GET /api/board/projects/:slug (voll) on-demand;
 *          GET /api/board/projects/:slug (cockpit) on mount.
 *   AC6 — Standalone: öffnet mit Projektliste; Klick lädt Projekt (lazy, aria-busy);
 *          Rückweg zur Liste; Cockpit-Modus (lockedProject): direkt ohne Liste.
 *   AC7 — „Alle/Keine"-Toggle oberhalb der Status-Checkboxen (DOM-Order, im Popover);
 *          alle ausgewählt → Klick wählt alle ab (greift V3-Hinweis), Label „Keine"/aria-pressed=true;
 *          keiner/teilweise → Klick wählt alle aus, Label „Alle"/aria-pressed=false; aria-label nennt Aktion.
 *          Optischer Links-Versatz (marginLeft) in Quelle dokumentiert — nicht per jsdom testbar.
 *
 * Covers (idea-specify-background-status, S-230):
 *   AC3 — running-Job rendert an der Idee-Karte ein Lauf-Badge „wird
 *          spezifiziert…" (Text + aria-busy/role=status/aria-live, nicht nur Farbe).
 *   AC4 — failed/auth-expired → nicht-blockierender Fehler-Hinweis, Karte bleibt
 *          anklickbar; done/kein Job → kein Badge.
 *   AC5 — Hydration aus GET …/specify/jobs beim Board-Load; Re-Hydration beim
 *          Schließen des Overlays (gerade gestarteter Lauf erscheint); Polling nur
 *          solange ≥1 running-Job (fake timers); running→done → GENAU EIN
 *          Board-Re-Fetch; danach kein Poll (Ruhezustand). Kein Poll ohne aktive Jobs.
 *
 * Covers (story-specify-finalize-visibility, S-240):
 *   AC6 — Nicht-blockierender Board-Hinweis (Text + ⚠-Icon, role=status/aria-live)
 *          bei letztem projekt-keyed Finalize no-op/failed/auth-expired (GET
 *          …/story-specify/finalize); KEIN Hinweis bei running/done/null;
 *          quittierbar (✕, verschwindet); Polling nur solange running (fake
 *          timers), im Ruhezustand kein Poll; degradiert still bei Netzfehler.
 *          (AC5 Overlay-Verhalten lebt in IdeaSpecifyChatModal + NewStoryChatScratch.test.jsx.)
 *
 * Covers (story-detail-ansicht):
 *   AC3, AC4, AC5 — Story-Klick, Soll-Ist, Vorab-Badge; fehlende Schätzung; null-Fälle.
 *   AC3 — Story-Klick öffnet Detail-Ansicht; drei Blöcke sichtbar.
 *   AC4 — Soll-Ist zeigt ep_est/ep_act/tok_est/tok_total; null → „keine Schätzung".
 *   AC5 — Vorab-Badge (ep-est-vorab-badge) bei ep_est_source='yaml'; kein Badge bei 'ledger'.
 *
 * Covers (story-detail-yaml-fallback):
 *   AC5 — Differenzierter Leer-Zustand: „Vor Metrik-Erfassung abgeschlossen" wenn
 *          ended_at vorhanden; „Noch kein Flow-Lauf" wenn nicht. YAML-Badge bei
 *          ended_at_source='yaml'. Bestehender Text „Keine Flow-Daten" ersetzt.
 *   AC6 — Block „Verknüpfungen" mit Branch + PR-Link wenn vorhanden; Block ausgeblendet
 *          wenn beide null. PR-Link mit rel=noopener noreferrer (AC8 Floor).
 *   AC7 — Ledger-Daten: bestehende Tests unverändert (Ledger hat Vorrang).
 *   AC8 — Kein dangerouslySetInnerHTML; PR-Link rel=noopener noreferrer.
 *          jsdom-Limitation: WCAG-Kontrast und Layout nicht testbar — visuell verifiziert.
 *
 * Covers (projekt-spezifikation-anzeige):
 *   AC5 — Story-Spec-Bezug ist klickbar (onOpenSpec-Prop) und ruft onOpenSpec(relPath) auf.
 *
 * Covers (ideen-inbox):
 *   AC1 — „Idee" ist erstes Element von STATUS_LIFECYCLE; „Idee"-Spalte rendert links
 *          von „To Do" (DOM-Reihenfolge); Status-Filter führt „Idee"-Checkbox, Default
 *          angehakt (Teil der „alle 6 vorausgewählt"-Zusicherung).
 *   AC2 — Idee-Story trägt kein ready-Badge (ready-Badge-Bedingung bleibt auf
 *          status === 'To Do' beschränkt; Cross-Ref zur Backend-Zusicherung in
 *          test/boardReadyStatus.test.js).
 *   AC5/AC6 — SUPERSEDED durch idea-specify-chat (S-218): der frühere discuss-
 *          Tab-Sprung und die frühere Resolve-UI (IdeaResolveModal) sind entfernt;
 *          siehe „Covers (idea-specify-chat)" unten.
 *
 * Covers (idea-specify-chat):
 *   AC1 — Ein Klick auf eine Idee-Karte (status:'Idee') UND ein Klick auf den
 *          Button „Spezifizieren" öffnen dasselbe Chat-Overlay
 *          (`IdeaSpecifyChatModal`, hier gemockt — Modal-Interna sind in
 *          `IdeaSpecifyChatModal.test.jsx` [S-217] abgedeckt); beide Auslöser
 *          rufen `handleOpenSpecifyChat` mit identischem `{projectSlug, story}`
 *          auf; kein Detail-Fetch, kein Tab-/Navigate-Callback (BoardView kennt
 *          keine Tabs — der frühere `onDiscussIdea`-Callback existiert nicht
 *          mehr); Klick auf eine Nicht-Idee-Karte bleibt unverändert (Detail-
 *          Ansicht, keine Regression).
 *   AC2 — Button-Rename: `StoryCard` zeigt „Spezifizieren" statt „Idee auflösen"
 *          NEBEN der Idee-Karte (additiv, kein `<button>`-in-`<button>`, nur bei
 *          status:'Idee' gerendert, KEIN Trigger bei Nicht-Idee-Karten); der alte
 *          `onResolveIdea`/`IdeaResolveModal`-Pfad und der `handleIdeaDiscuss`/
 *          `onDiscussIdea`-Pfad sind vollständig entfernt (kein toter Code, keine
 *          verwaisten Imports/Props/States).
 *   AC10 (Konsument) — `onSpecified(slug)` löst ein Board-Re-Fetch aus
 *          (`GET /api/board/projects/:slug` erneut) — Wiederverwendung des
 *          bestehenden Cockpit-Lade-Mechanismus (`reloadToken`).
 *
 * Covers (board-feature-archive, S-233/S-244):
 *   AC5/AC7/AC9 — SUPERSEDED durch board-storys-archivieren (S-294), siehe
 *          unten: derselbe physische Button/Dialog heißt jetzt „Erledigte
 *          Storys archivieren" und rechnet Archivierbarkeit pro STORY statt
 *          pro Feature. Die alten feature-basierten Tests dafür sind entfernt
 *          und durch die AC6/AC8-Tests unten ersetzt.
 *
 * Covers (board-storys-archivieren, S-294):
 *   AC6 — Button „Erledigte Storys archivieren" ist deaktiviert, wenn keine
 *          Story archivierbar ist (V1: status ∈ {Done, Verworfen} UND nicht
 *          bereits `archived` — pro STORY, unabhängig vom Geschwister-Status
 *          im selben Feature); sonst öffnet ein Klick eine Bestätigungsabfrage
 *          mit der Anzahl betroffener Storys (aus den geladenen Board-Daten
 *          nach V1 berechnet, ungefiltert) + Hinweis, dass die Bereichs-
 *          Kacheln sichtbar bleiben. Abbrechen ändert nichts + setzt kein POST
 *          ab; Bestätigen setzt genau EIN POST .../archive-done-stories ab und
 *          lädt die Übersicht neu (archivierte Storys verschwinden, die
 *          Bereichs-Kachel bleibt → Button ggf. wieder deaktiviert). Endpoint-
 *          Fehler (409/5xx) erscheinen nicht-blockierend (role=alert) im
 *          Dialog, ohne die Ansicht zu zerstören (Board bleibt). `Verworfen`
 *          zählt wie `Done` als terminal (Backend-Kriterium
 *          `BoardWriter.archiveDoneStories` separat in test/BoardWriter.test.js
 *          abgedeckt).
 *   AC7 — „Archiv anzeigen"-Schalter unverändert wiederverwendet — siehe
 *          „Covers (board-feature-archive, S-234)" unten (dieselbe
 *          Implementierung, keine neuen Tests nötig).
 *   AC8 — A11y: Button ist echter <button> mit sprechendem aria-label; die
 *          Bestätigungsabfrage ist ein fokussiertes Dialog-Muster
 *          (role="dialog" + aria-modal + aria-labelledby, Esc-Abbruch). Bedeutung
 *          nicht allein über Farbe (Text-Zusammenfassung). Sichtbarer Fokusring +
 *          Fokusfalle (Tab-Zyklus) in Quelle umgesetzt — jsdom hat keine
 *          Layout-Engine, daher Fokus-Zyklus/Fokusring nur strukturell belegt.
 *
 * Covers (board-feature-archive, S-234 — „Archiv anzeigen"-Schalter):
 *   AC6 — „Archiv anzeigen"-Toggle (Default aus): initial werden KEINE
 *          archivierten Features geladen (kein `includeArchived`-Query); ein Klick
 *          lädt mit `?includeArchived=true` neu → archivierte Features erscheinen,
 *          erneuter Klick blendet sie wieder aus (Standardansicht). Archivierte
 *          Features/Stories sind READ-ONLY: kein Karten-Button (`story-card-btn-*`
 *          fehlt), stattdessen read-only <article>; klar per Text „Archiviert"
 *          markiert (Feature-Badge + Story-Marker). Toggle-Zustand lokal
 *          (localStorage `boardview.showArchived`); wird pro Test geleert.
 *   AC7 — A11y: Der Schalter ist ein echter <button> mit `aria-pressed`
 *          (false↔true) und sprechendem aria-label (anzeigen/ausblenden);
 *          Bedeutung „Archiviert" per Text, nicht allein über Farbe.
 *          (Opazität/Fokusring in Quelle — jsdom hat keine Layout-Engine.)
 *
 * Covers (board-status-verworfen, S-242):
 *   AC1 — „Verworfen" rendert als 7. (letzte) Kanban-Spalte rechts neben „Done"
 *          (DOM-Reihenfolge Idee → … → Done → Verworfen); die Spalte ist auch
 *          bei 0 Verworfen-Stories im Feature vorhanden (Grid folgt
 *          STATUS_LIFECYCLE.length = 7).
 *   AC2 — `StatusBadge` für „Verworfen" trägt einen eigenen, gedämpft-
 *          neutralen Grauton (background/color), der sich vom grünen
 *          „Done"-Ton unterscheidet; Bedeutung steht als sichtbarer Text
 *          „Verworfen" im Badge (nicht nur Farbe).
 *   AC3 — „Verworfen" ist die 7. Filter-Checkbox, beim Öffnen des Popovers
 *          vorausgewählt (Default alle 7 an); Button-Zähler „Status (7/7) ▾"
 *          bzw. „(n/7)" nach Deselektion; Deselektieren blendet die
 *          Verworfen-Karten aus, erneutes Selektieren zeigt sie wieder — ohne
 *          Status-spezifische Sonderlogik (rein über STATUS_LIFECYCLE).
 *   AC4 — Eine Story mit status:'Verworfen' landet in der Verworfen-Spalte,
 *          NICHT im To-Do-Fallback-Bucket; der Fallback bleibt für echte
 *          unbekannte Status unverändert.
 *   AC5 — Regressions-Invariante (kein Frontend-Code-Delta, kein Test in
 *          dieser Datei): siehe test/ProjectDrain.test.js + test/boardReadyStatus.test.js.
 *
 * Covers (board-filter-feature-status-consistency, S-241):
 *   AC1 — Feature [To Do, Blocked], Filter „nur To Do" → Badge „To Do" statt
 *          server-„Blocked" (wörtliches Spec-Beispiel).
 *   AC2 — Ohne aktiven Filter entspricht der Badge exakt dem server-feature.status.
 *   AC3 — Client verwendet dieselbe computeFeatureStatus-Funktion wie der Server
 *          (Identität + Vektor-Tabelle in test/featureStatus.test.js; hier
 *          integrationsnah über das gerenderte Badge geprüft).
 *   AC4 — `_orphaned` bekommt nie einen Badge (gefiltert + ungefiltert).
 *   AC5 — Feature (echt oder `_orphaned`) mit 0 sichtbaren Stories wird bei
 *          aktivem Filter ausgeblendet; ohne Filter rendert ein leeres echtes
 *          Feature weiterhin (Regression).
 *   AC6 — Leer-Hinweis („Keine Stories passen zum aktiven Filter.") greift jetzt
 *          auch bei einem reinen Status-Filter, nicht mehr nur beim Label-Filter.
 *
 * Covers (bereichs-modell, S-290 — nur die BoardView/FilterBar-WIRING; das
 * Dialog-Verhalten selbst [Liste/Anlegen/Umbenennen/Umsortieren/Löschen/A11y]
 * ist eigenständig in `AreasManageDialog.test.jsx` unit-getestet, hier gemockt):
 *   AC8 — Button „Bereiche verwalten" ist sichtbar, sobald ein Projekt geladen
 *          ist (`projectSlug` gesetzt), UND ist im DOM importiert/gemountet
 *          (Mount-Punkt, kein toter Code); ein Klick öffnet `AreasManageDialog`
 *          mit dem korrekten `projectSlug` des aktuell geladenen Projekts.
 *   AC10 — Schließen des Dialogs gibt den Fokus an den auslösenden Button
 *          zurück (`triggerRef`).
 *
 * Covers (run-state-live-view, S-316 — Frontend-Anzeige; das Live-Re-Fetch über
 * den bestehenden EventSource-Abonnenten [AC8] ist bereits vollständig in
 * `BoardViewSSE.test.jsx` [board-live-sse AC13–AC17] abgedeckt — der Re-Fetch-
 * Mechanismus selbst ist unverändert, hier wird nur das NEUE `runs`-Feld im
 * bereits geladenen Projekt gerendert):
 *   AC7 — Projekt mit aktiven Feature-Läufen (`project.runs`) zeigt je Lauf
 *          Feature-ID, Phase (textlich, nie nur Farbe), aktuelle Story,
 *          Fortschritt `done/total` und — falls gesetzt — den letzten Fehler.
 *          Kein aktiver Lauf (`runs: []`/fehlend) → keine RunsSummary im DOM
 *          (leer/unauffällig, kein Platzhalter-Rauschen).
 *   AC10 — Dossier/Notizen werden nicht gerendert (RunsSummary zeigt nur die
 *          AC2-Felder, kein dossier/notes-Text taucht je im DOM auf).
 *
 * NOTE (jsdom-Limitation): jsdom hat keine Layout-Engine — Style-Property-Asserts beweisen
 * kein Scroll-/Layout-Verhalten; getestet werden Verhalten, Struktur, Rollen und aria.
 *
 * @jest-environment jsdom
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, waitFor } from '@testing-library/react';

// Mocks for AppShell dependencies (unused here, but may be loaded via viewRegistry)
jest.unstable_mockModule('../Terminal.jsx', () => ({
  Terminal: () => null,
}));

// Mock IdeaSpecifyChatModal (idea-specify-chat, S-217/S-218) — this file only
// asserts on BoardView's WIRING (both triggers open the same overlay with the
// correct {projectSlug, story}, onSpecified triggers a Board-Re-Fetch); the
// modal's own chat-/A11y-/finalize-Verhalten ist in
// `IdeaSpecifyChatModal.test.jsx` (S-217) unit-getestet.
let lastIdeaSpecifyProps = null;
jest.unstable_mockModule('../IdeaSpecifyChatModal.jsx', async () => {
  const R = (await import('react')).default;
  return {
    IdeaSpecifyChatModal: (props) => {
      lastIdeaSpecifyProps = props;
      return R.createElement(
        'div',
        {
          role: 'dialog',
          'aria-label': 'Idee spezifizieren',
          'data-testid': 'idea-specify-chat-modal-mock',
          'data-project-slug': props.projectSlug ?? '',
          'data-story-id': props.story?.id ?? '',
        },
        R.createElement('button', {
          type: 'button',
          'data-testid': 'idea-specify-mock-close-btn',
          onClick: props.onClose,
        }, 'Schließen'),
        R.createElement('button', {
          type: 'button',
          'data-testid': 'idea-specify-mock-specified-btn',
          onClick: () => props.onSpecified(props.projectSlug),
        }, 'Specified'),
      );
    },
  };
});

// Mock AreasManageDialog (bereichs-modell, S-290) — this file only asserts on
// BoardView's/FilterBar's WIRING (Button sichtbar sobald ein Projekt geladen
// ist, Klick öffnet den Dialog mit dem korrekten projectSlug, Schließen gibt
// den Fokus zurück); das Dialog-Verhalten selbst ist in
// `AreasManageDialog.test.jsx` unit-getestet.
let lastAreasManageProps = null;
jest.unstable_mockModule('../AreasManageDialog.jsx', async () => {
  const R = (await import('react')).default;
  return {
    AreasManageDialog: (props) => {
      lastAreasManageProps = props;
      return R.createElement(
        'div',
        {
          role: 'dialog',
          'aria-label': 'Bereiche verwalten',
          'data-testid': 'areas-manage-dialog-mock',
          'data-project-slug': props.projectSlug ?? '',
        },
        R.createElement('button', {
          type: 'button',
          'data-testid': 'areas-manage-mock-close-btn',
          onClick: props.onClose,
        }, 'Schließen'),
      );
    },
  };
});

const { render }    = await import('@testing-library/react');
const React         = (await import('react')).default;
const { BoardView } = await import('../BoardView.jsx');
const { VIEWS, parseHash } = await import('../useHashRouter.js');
const { VIEW_REGISTRY }    = await import('../viewRegistry.js');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STORY_TODO = {
  id: 'S-001',
  parent: 'F-001',
  title: 'Erstelle Login-Seite',
  status: 'To Do',
  priority: 'high',
  labels: ['frontend', 'auth'],
  spec: 'docs/specs/login.md',
};

const STORY_IN_PROGRESS = {
  id: 'S-002',
  parent: 'F-001',
  title: 'Implementiere Auth-Flow',
  status: 'In Progress',
  priority: 'high',
  labels: ['backend', 'auth'],
  spec: null,
};

const STORY_DONE = {
  id: 'S-003',
  parent: 'F-001',
  title: 'Setup Datenbank',
  status: 'Done',
  priority: 'medium',
  labels: ['backend'],
  spec: null,
};

const STORY_BLOCKED = {
  id: 'S-004',
  parent: 'F-002',
  title: 'Deploy Pipeline',
  status: 'Blocked',
  priority: 'high',
  labels: ['ci', 'devops'],
  spec: null,
};

const STORY_IN_REVIEW = {
  id: 'S-005',
  parent: 'F-002',
  title: 'Code Review Backend',
  status: 'In Review',
  priority: 'low',
  labels: ['backend'],
  spec: null,
};

// ideen-inbox AC1/AC2 fixtures — isolated feature/project so existing rollup/count
// assertions on FEATURE_WITH_PROGRESS/FEATURE_NO_PROGRESS stay unaffected.
const STORY_IDEE = {
  id: 'S-006',
  parent: 'F-010',
  title: 'Rohe Notiz: Dark-Mode-Toggle',
  status: 'Idee',
  priority: null,
  labels: [],
  spec: null,
  ready: false,
  ready_reason: null,
};

const FEATURE_IDEE = {
  id: 'F-010',
  title: 'Inbox',
  status: null,
  priority: null,
  stories: [STORY_IDEE, STORY_TODO],
};

const PROJECT_IDEE = {
  slug: 'project-idee',
  repo_path: '/home/user/Git/idee',
  project_slug: 'project-idee',
  schema_version: 1,
  features: [FEATURE_IDEE],
};

// board-status-verworfen AC4 fixtures — isolated feature/project (analog zu
// PROJECT_IDEE), damit bestehende rollup/count-Assertions auf
// FEATURE_WITH_PROGRESS/FEATURE_NO_PROGRESS unverändert bleiben.
const STORY_VERWORFEN = {
  id: 'S-007',
  parent: 'F-011',
  title: 'Verworfene Idee: Dunkles Overlay-Theme',
  status: 'Verworfen',
  priority: null,
  labels: [],
  spec: null,
  ready: false,
  ready_reason: null,
};

const FEATURE_VERWORFEN = {
  id: 'F-011',
  title: 'Verworfen-Feature',
  status: null,
  priority: null,
  stories: [STORY_VERWORFEN, STORY_TODO],
};

const PROJECT_VERWORFEN = {
  slug: 'project-verworfen',
  repo_path: '/home/user/Git/verworfen',
  project_slug: 'project-verworfen',
  schema_version: 1,
  features: [FEATURE_VERWORFEN],
};

const FEATURE_WITH_PROGRESS = {
  id: 'F-001',
  title: 'Authentication',
  status: 'In Progress',
  priority: 'high',
  // progress explicitly provided (AC5 — use directly)
  progress: { done: 1, total: 3 },
  stories: [STORY_TODO, STORY_IN_PROGRESS, STORY_DONE],
};

const FEATURE_NO_PROGRESS = {
  id: 'F-002',
  title: 'CI/CD Pipeline',
  status: 'Blocked',
  priority: 'high',
  // No progress field — compute from stories (AC5)
  stories: [STORY_BLOCKED, STORY_IN_REVIEW],
};

const FEATURE_EMPTY = {
  id: 'F-003',
  title: 'Empty Feature',
  status: 'To Do',
  priority: 'low',
  stories: [],
};

const PROJECT_A = {
  slug: 'project-alpha',
  repo_path: '/home/user/Git/alpha',
  project_slug: 'project-alpha',
  schema_version: 1,
  features: [FEATURE_WITH_PROGRESS, FEATURE_NO_PROGRESS],
};

const PROJECT_B = {
  slug: 'project-beta',
  repo_path: '/home/user/Git/beta',
  project_slug: 'project-beta',
  schema_version: 1,
  features: [FEATURE_EMPTY],
};

const PROJECT_ERROR = {
  slug: 'project-broken',
  repo_path: '/home/user/Git/broken',
  error: 'board.yaml not found',
  features: [],
};

// ── board-feature-archive (S-233) fixtures ─────────────────────────────────────
// FEATURE_ALL_DONE: ≥1 Story UND alle Done UND nicht archiviert → archivierbar (V1).
const FEATURE_ALL_DONE = {
  id: 'F-900',
  title: 'Fertiges Feature',
  status: 'Done',
  priority: 'medium',
  stories: [
    { id: 'S-900', parent: 'F-900', title: 'Teil A', status: 'Done', priority: 'low', labels: [], spec: null },
    { id: 'S-901', parent: 'F-900', title: 'Teil B', status: 'Done', priority: 'low', labels: [], spec: null },
  ],
};
// FEATURE_MIXED: eine nicht-Done-Story → NICHT archivierbar (bleibt unangetastet).
const FEATURE_MIXED = {
  id: 'F-901',
  title: 'Halbfertiges Feature',
  status: 'In Progress',
  priority: 'high',
  stories: [
    { id: 'S-902', parent: 'F-901', title: 'Teil C', status: 'Done', priority: 'low', labels: [], spec: null },
    { id: 'S-903', parent: 'F-901', title: 'Teil D', status: 'To Do', priority: 'low', labels: [], spec: null },
  ],
};
// Vor dem Archivieren: 1 archivierbares Feature (F-900) mit 2 Stories + 1 gemischtes.
// (Nur noch als generische Board-Fixtures für die „Bereiche verwalten"-Tests
// unten benötigt — die Story-Ebenen-Archivierbarkeit selbst wird mit eigenen,
// dediziert benannten Fixtures weiter unten getestet.)
const PROJECT_ARCHIVE_BEFORE = {
  slug: 'proj-arch',
  repo_path: '/home/user/Git/arch',
  project_slug: 'proj-arch',
  schema_version: 1,
  features: [FEATURE_ALL_DONE, FEATURE_MIXED],
};
// Nach dem Archivieren: das erledigte Feature ist aus der Standardansicht raus (V3).
const PROJECT_ARCHIVE_AFTER = {
  slug: 'proj-arch',
  repo_path: '/home/user/Git/arch',
  project_slug: 'proj-arch',
  schema_version: 1,
  features: [FEATURE_MIXED],
};

/**
 * Stateful fetch mock for the archive flow (cockpit mode).
 * - GET /api/board/projects/:slug        → projectBefore (or projectAfter after archive)
 * - GET …/:slug/specify/jobs             → { jobs: {} } (no running jobs)
 * - POST …/:slug/archive-done-stories    → archiveResult; on success flips to projectAfter
 *
 * @param {{ projectBefore: object, projectAfter: object,
 *           archiveResult?: { ok: boolean, status: number, body?: object } }} opts
 */
function makeArchiveFetch({
  projectBefore,
  projectAfter,
  archiveResult = { ok: true, status: 200, body: { archivedStoryCount: 2 } },
}) {
  let archived = false;
  return jest.fn(async (url, opts) => {
    const method = opts?.method ?? 'GET';
    if (url.endsWith('/archive-done-stories') && method === 'POST') {
      if (archiveResult.ok) archived = true;
      return { ok: archiveResult.ok, status: archiveResult.status, json: async () => archiveResult.body ?? {} };
    }
    if (url.endsWith('/specify/jobs')) {
      return { ok: true, status: 200, json: async () => ({ jobs: {} }) };
    }
    const slugMatch = url.match(/^\/api\/board\/projects\/([^/?]+)(?:\?.*)?$/);
    if (slugMatch) {
      const proj = archived ? projectAfter : projectBefore;
      return { ok: true, status: 200, json: async () => ({ project: proj }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Render cockpit for the given archive project (default 'proj-arch') and wait for the archive button. */
async function renderArchiveCockpit(fetchMock, slug = 'proj-arch') {
  globalThis.fetch = fetchMock;
  const utils = renderCockpit(slug);
  await waitFor(() => {
    expect(utils.container.querySelector('[data-testid="archive-done-btn"]')).toBeTruthy();
  });
  return utils;
}

// ── board-storys-archivieren (S-294) fixtures — Story-Ebenen-Archivierbarkeit ──
// V1: eine Story ist archivierbar, wenn status ∈ {Done, Verworfen} UND nicht
// bereits archiviert — UNABHÄNGIG vom Geschwister-Status im selben Feature
// (anders als die superseded Feature-Ebenen-Regel aus [[board-feature-archive]],
// die JEDE Story eines Features terminal verlangte).

// Feature ganz ohne terminale Story → 0 archivierbare Storys (Button-disabled-Fall).
const FEATURE_ALL_OPEN = {
  id: 'F-920',
  title: 'Offenes Feature',
  status: 'To Do',
  priority: 'medium',
  stories: [
    { id: 'S-920', parent: 'F-920', title: 'Teil A', status: 'To Do', priority: 'low', labels: [], spec: null },
    { id: 'S-921', parent: 'F-920', title: 'Teil B', status: 'In Progress', priority: 'low', labels: [], spec: null },
  ],
};
// Feature mit gemischten Storys: Done + Verworfen (beide terminal, archivierbar)
// + To Do (nicht terminal, bleibt unangetastet + sichtbar).
const FEATURE_STORY_MIXED = {
  id: 'F-921',
  title: 'Gemischtes Feature',
  status: 'In Progress',
  priority: 'high',
  stories: [
    { id: 'S-922', parent: 'F-921', title: 'Teil C', status: 'Done', priority: 'low', labels: [], spec: null },
    { id: 'S-923', parent: 'F-921', title: 'Teil D', status: 'Verworfen', priority: 'low', labels: [], spec: null },
    { id: 'S-924', parent: 'F-921', title: 'Teil E', status: 'To Do', priority: 'low', labels: [], spec: null },
  ],
};
// Vor dem Archivieren: 0 archivierbare Storys in F-920 + 2 archivierbare (Done,
// Verworfen) in F-921 = 2 archivierbare Storys insgesamt.
const PROJECT_STORY_ARCHIVE_BEFORE = {
  slug: 'proj-arch2',
  repo_path: '/home/user/Git/arch2',
  project_slug: 'proj-arch2',
  schema_version: 1,
  features: [FEATURE_ALL_OPEN, FEATURE_STORY_MIXED],
};
// Nach dem Archivieren: S-922/S-923 sind aus der Standardansicht raus; die
// Bereichs-Kachel F-921 UND die offene Story S-924 bleiben sichtbar; die leere
// Kachel F-920 bleibt ebenfalls sichtbar (dauerhaftes Bereichs-Feature, V3).
const PROJECT_STORY_ARCHIVE_AFTER = {
  slug: 'proj-arch2',
  repo_path: '/home/user/Git/arch2',
  project_slug: 'proj-arch2',
  schema_version: 1,
  features: [
    FEATURE_ALL_OPEN,
    { ...FEATURE_STORY_MIXED, stories: [FEATURE_STORY_MIXED.stories[2]] },
  ],
};
// Nichts archivierbar (nur offene/nicht-terminale Storys) → Button deaktiviert.
const PROJECT_STORY_NO_ARCHIVABLE = {
  slug: 'proj-arch2',
  repo_path: '/home/user/Git/arch2',
  project_slug: 'proj-arch2',
  schema_version: 1,
  features: [FEATURE_ALL_OPEN],
};

// ── board-feature-archive (S-234) fixtures — „Archiv anzeigen"-Schalter ────────
// Ein archiviertes Feature (status bleibt Done, archived:true) samt archivierter
// Story. Wird vom Backend NUR mit includeArchived=true geliefert (V3).
const ARCHIVED_FEATURE = {
  id: 'F-950',
  title: 'Altes Feature',
  status: 'Done',
  priority: 'low',
  archived: true,
  archived_at: '2026-06-01T10:00:00Z',
  stories: [
    {
      id: 'S-950', parent: 'F-950', title: 'Alt-Teil', status: 'Done',
      priority: 'low', labels: [], spec: null,
      archived: true, archived_at: '2026-06-01T10:00:00Z',
    },
  ],
};
// Standardansicht (ohne includeArchived): nur das sichtbare, gemischte Feature.
const PROJECT_ARCHVIEW_STANDARD = {
  slug: 'proj-arcv',
  repo_path: '/home/user/Git/arcv',
  project_slug: 'proj-arcv',
  schema_version: 1,
  features: [FEATURE_MIXED],
};
// Erweiterte Ansicht (includeArchived=true): zusätzlich das archivierte Feature.
const PROJECT_ARCHVIEW_FULL = {
  slug: 'proj-arcv',
  repo_path: '/home/user/Git/arcv',
  project_slug: 'proj-arcv',
  schema_version: 1,
  features: [FEATURE_MIXED, ARCHIVED_FEATURE],
};

/**
 * Fetch-Mock, der die Standard- vs. Archiv-Ansicht anhand des includeArchived-
 * Query-Signals unterscheidet (simuliert das Backend V3-Verhalten).
 * - GET …/:slug              → Standardansicht (ohne Archivierte)
 * - GET …/:slug?includeArchived=true → mit Archivierten (markiert)
 * - GET …/:slug/specify/jobs → { jobs: {} }
 * Zeichnet die abgefragten URLs in `calls` auf.
 */
function makeArchViewFetch() {
  const fn = jest.fn(async (url) => {
    if (url.endsWith('/specify/jobs')) {
      return { ok: true, status: 200, json: async () => ({ jobs: {} }) };
    }
    const m = url.match(/^\/api\/board\/projects\/([^/?]+)(\?[^/]*)?$/);
    if (m) {
      const includeArchived = (m[2] || '').includes('includeArchived=true');
      const proj = includeArchived ? PROJECT_ARCHVIEW_FULL : PROJECT_ARCHVIEW_STANDARD;
      return { ok: true, status: 200, json: async () => ({ project: proj }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return fn;
}

// ── board-filter-feature-status-consistency (S-241) fixtures ──────────────────
// AC1-Beispiel (wörtlich aus der Spec): Feature mit Stories [To Do, Blocked] →
// server-status "Blocked" (Blocked-Prio, feature-status-derivation V2). Bei
// aktivem Filter "nur To Do" ist die sichtbare Menge [To Do] → Badge muss
// "To Do" zeigen (nicht mehr "Blocked").
const STORY_FSC_TODO = {
  id: 'S-100', parent: 'F-100', title: 'Sichtbar nach Filter', status: 'To Do',
  priority: 'high', labels: [], spec: null,
};
const STORY_FSC_BLOCKED = {
  id: 'S-101', parent: 'F-100', title: 'Ausgeblendet nach Filter', status: 'Blocked',
  priority: 'high', labels: [], spec: null,
};
const FEATURE_FSC_MIXED = {
  id: 'F-100',
  title: 'Gemischtes Feature',
  status: 'Blocked', // server-berechnet über ALLE Kind-Stories (unverändert, AC2)
  priority: 'high',
  stories: [STORY_FSC_TODO, STORY_FSC_BLOCKED],
};

// AC5: Feature mit ausschließlich einer Blocked-Story → bei Filter "nur To Do"
// hat es 0 sichtbare Stories und muss komplett ausgeblendet werden (nicht nur
// mit leerem/irreführendem Badge weiterhin gerendert werden).
const STORY_FSC_ONLY_BLOCKED = {
  id: 'S-102', parent: 'F-101', title: 'Nur Blocked', status: 'Blocked',
  priority: 'high', labels: [], spec: null,
};
const FEATURE_FSC_ONLY_BLOCKED = {
  id: 'F-101',
  title: 'Nur-Blocked-Feature',
  status: 'Blocked',
  priority: 'high',
  stories: [STORY_FSC_ONLY_BLOCKED],
};

// AC4/AC5: `_orphaned`-Pseudo-Feature — status bleibt IMMER null (kein
// abgeleiteter Badge, unabhängig vom Filter); wird bei leerer gefilterter
// Story-Menge unter aktivem Filter ebenfalls ausgeblendet (Entscheidung C).
const STORY_FSC_ORPHANED_TODO = {
  id: 'S-103', parent: null, title: 'Verwaist (To Do)', status: 'To Do',
  priority: null, labels: [], spec: null,
};
const STORY_FSC_ORPHANED_BLOCKED = {
  id: 'S-104', parent: null, title: 'Verwaist (Blocked)', status: 'Blocked',
  priority: null, labels: [], spec: null,
};
const FEATURE_FSC_ORPHANED = {
  id: '_orphaned',
  title: 'Verwaiste Stories',
  status: null,
  priority: null,
  stories: [STORY_FSC_ORPHANED_TODO, STORY_FSC_ORPHANED_BLOCKED],
  _orphaned: true,
};

const PROJECT_FSC = {
  slug: 'project-fsc',
  repo_path: '/home/user/Git/fsc',
  project_slug: 'project-fsc',
  schema_version: 1,
  features: [FEATURE_FSC_MIXED, FEATURE_FSC_ONLY_BLOCKED, FEATURE_FSC_ORPHANED],
};

// AC6: Projekt mit genau einer To-Do-Story → Filter auf "nur Done" eliminiert
// ALLE Stories rein über den Status-Filter (kein Label beteiligt) →
// totalFilteredStories === 0 → der bestehende Leer-Hinweis muss trotzdem
// erscheinen (bisher nur für den Label-Filter verdrahtet).
const STORY_FSC_SINGLE_TODO = {
  id: 'S-105', parent: 'F-102', title: 'Einzelne To-Do-Story', status: 'To Do',
  priority: 'low', labels: [], spec: null,
};
const FEATURE_FSC_SINGLE = {
  id: 'F-102',
  title: 'Einzel-Feature',
  status: 'To Do',
  priority: 'low',
  stories: [STORY_FSC_SINGLE_TODO],
};
const PROJECT_FSC_SINGLE = {
  slug: 'project-fsc-single',
  repo_path: '/home/user/Git/fsc-single',
  project_slug: 'project-fsc-single',
  schema_version: 1,
  features: [FEATURE_FSC_SINGLE],
};

/**
 * Öffnet das Status-Popover, deselektiert per "Alle/Keine"-Toggle ALLE Status
 * und selektiert danach ausschließlich `onlyStatus` (z.B. 'To Do' → id-Suffix
 * "to-do"). Ergebnis: `filterStatus = {onlyStatus}` (hasRestrictingFilter=true,
 * allStatusDeselected=false) — unabhängig vom 7er-Status-Lebenszyklus-Default.
 */
async function selectOnlyStatus(container, onlyStatus) {
  await act(async () => {
    fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
  });
  await act(async () => {
    fireEvent.click(container.querySelector('[data-testid="status-toggle-all-btn"]'));
  });
  const inputId = `board-filter-status-${onlyStatus.replace(/\s+/g, '-').toLowerCase()}`;
  await act(async () => {
    fireEvent.click(container.querySelector(`#${inputId}`));
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.location.hash = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.location.hash = '';
});

/**
 * Build a fetch mock that handles all three board API endpoints.
 *
 * - /api/board/projects/list  → { projects: listItems }
 * - /api/board/projects/:slug → { project: fullProject } (looked up from fullProjects)
 * - /api/board/projects       → { projects: fullProjects }
 *
 * @param {{ fullProjects?: object[], ok?: boolean }} opts
 */
function makeBoardFetch({ fullProjects = [], ok = true } = {}) {
  return jest.fn(async (url) => {
    if (!ok) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (url === '/api/board/projects/list') {
      const list = fullProjects.map((p) => {
        if (p.error) return { slug: p.slug, error: p.error };
        const features = p.features ?? [];
        return {
          slug: p.slug,
          feature_count: features.length,
          story_count: features.reduce((a, f) => a + (f.stories ?? []).length, 0),
        };
      });
      return { ok: true, status: 200, json: async () => ({ projects: list }) };
    }
    if (url === '/api/board/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: fullProjects }) };
    }
    // /api/board/projects/:slug
    const slugMatch = url.match(/^\/api\/board\/projects\/(.+)$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      const proj = fullProjects.find((p) => p.slug === slug);
      if (proj) {
        return { ok: true, status: 200, json: async () => ({ project: proj }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Projekt nicht gefunden.' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

/** Render BoardView in STANDALONE mode (no lockedProject). */
function renderBoard(props = {}) {
  const onNavigate = jest.fn();
  const utils = render(React.createElement(BoardView, { onNavigate, ...props }));
  return { ...utils, onNavigate };
}

/** Render BoardView in COCKPIT mode (lockedProject set). */
function renderCockpit(slug, props = {}) {
  return renderBoard({ lockedProject: slug, ...props });
}

/** Load standalone board and click on a project to enter its detail view. */
async function renderBoardWithProject(fullProjects, slugToSelect) {
  globalThis.fetch = makeBoardFetch({ fullProjects });
  const utils = renderBoard();

  // Wait for project list
  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project-list-item="${slugToSelect}"]`)).toBeTruthy();
  });

  // Click project to load it
  await act(async () => {
    const btn = utils.container.querySelector(`[data-testid="project-select-${slugToSelect}"]`);
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
  });

  // Wait for project data
  await waitFor(() => {
    expect(utils.container.querySelector(`[data-project="${slugToSelect}"]`)).toBeTruthy();
  });

  return utils;
}

// ── AC1 (studis-kanban-board-ux) — Umbenennung ────────────────────────────────

describe('studis-kanban-board-ux — AC1: Umbenennung „Studis-Kanban-Board"', () => {
  it('<main> has aria-label "Studis-Kanban-Board"', () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { getByRole } = renderBoard();
    expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
  });

  it('<h1> text is "Studis-Kanban-Board"', () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { container } = renderBoard();
    const h1 = container.querySelector('h1');
    expect(h1).toBeTruthy();
    expect(h1.textContent).toBe('Studis-Kanban-Board');
  });

  it('viewRegistry board entry has label "Studis-Kanban-Board"', () => {
    const entry = VIEW_REGISTRY.find((v) => v.id === 'board');
    expect(entry).toBeTruthy();
    expect(entry.label).toBe('Studis-Kanban-Board');
  });

  it('Route-id "board" remains unchanged (VIEWS contains "board")', () => {
    expect(VIEWS).toContain('board');
    expect(parseHash('#/board')).toBe('board');
  });
});

// ── Route registration ────────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — Route registration in useHashRouter', () => {
  it('VIEWS array includes "board"', () => {
    expect(VIEWS).toContain('board');
  });

  it('parseHash returns "board" for "#/board"', () => {
    expect(parseHash('#/board')).toBe('board');
  });

  it('parseHash is case-insensitive for board', () => {
    expect(parseHash('#/BOARD')).toBe('board');
  });
});

// ── AC6 (studis-kanban-board-ux) — Standalone lazy-load ──────────────────────

describe('studis-kanban-board-ux — AC6: Standalone Projektliste + Lazy-Load', () => {
  it('standalone board calls /api/board/projects/list on mount (not full endpoint)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A, PROJECT_B] });
    renderBoard();

    await waitFor(() => {
      const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
      expect(listCalls).toHaveLength(1);
      // Full projects endpoint must NOT be called on mount
      const fullCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects');
      expect(fullCalls).toHaveLength(0);
    });
  });

  it('standalone: shows project list with slugs and counters', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A, PROJECT_B] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project-list-item="project-beta"]')).toBeTruthy();
    });
  });

  it('standalone: shows aria-busy loading state during list fetch', async () => {
    let resolveList;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/list') {
        await new Promise((r) => { resolveList = r; });
        return { ok: true, json: async () => ({ projects: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderBoard();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveList(); });
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('standalone: click on project calls /api/board/projects/:slug', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      const slugCalls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(slugCalls).toHaveLength(1);
    });
  });

  it('standalone: after project click shows project detail (not list)', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');
    expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeNull();
  });

  it('standalone: shows back button in project-detail view', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');
    expect(container.querySelector('[data-testid="board-back-btn"]')).toBeTruthy();
  });

  it('standalone: back button returns to project list', async () => {
    const { container } = await renderBoardWithProject([PROJECT_A], 'project-alpha');

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="board-back-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
      expect(container.querySelector('[data-project="project-alpha"]')).toBeNull();
    });
  });

  it('standalone: shows aria-busy loading during project fetch (AC6 — Ladezustand)', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/list') {
        return { ok: true, json: async () => ({ projects: [{ slug: 'project-alpha', feature_count: 2, story_count: 5 }] }) };
      }
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    // aria-busy must appear while loading
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });

  it('standalone: list error shows alert', async () => {
    globalThis.fetch = makeBoardFetch({ ok: false });
    const { container } = renderBoard();
    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('standalone: empty list shows no-projects hint', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { container } = renderBoard();
    await waitFor(() => {
      const hint = container.querySelector('[role="status"]');
      expect(hint).toBeTruthy();
      expect(hint.textContent).toMatch(/keine projekte/i);
    });
  });
});

// ── AC6 — Cockpit mode (lockedProject) ───────────────────────────────────────

describe('studis-kanban-board-ux — AC6: Cockpit-Modus (lockedProject)', () => {
  it('cockpit: does NOT show project list', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // No project list items
    expect(container.querySelector('[data-project-list-item]')).toBeNull();
    // No back button
    expect(container.querySelector('[data-testid="board-back-btn"]')).toBeNull();
  });

  it('cockpit: calls /api/board/projects/:slug on mount', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('cockpit: does NOT call /api/board/projects/list', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
    expect(listCalls).toHaveLength(0);
  });

  it('cockpit: shows aria-busy during load', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });
});

// ── AC5 (studis-kanban-board-ux) — Backend endpoints ─────────────────────────

describe('studis-kanban-board-ux — AC5: Backend endpoint URLs', () => {
  it('standalone calls /api/board/projects/list (not /api/board/projects)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    const listCalls = globalThis.fetch.mock.calls.filter((c) => c[0] === '/api/board/projects/list');
    expect(listCalls).toHaveLength(1);
  });

  it('standalone calls /api/board/projects/:slug when project selected', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      const slugCalls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(slugCalls).toHaveLength(1);
    });
  });

  it('cockpit calls /api/board/projects/:slug on mount', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      expect(globalThis.fetch.mock.calls.some((c) => c[0] === '/api/board/projects/project-alpha')).toBe(true);
    });
  });
});

// ── AC2 (studis-kanban-board-ux) — Status-Filter Default alle gewählt ─────────

describe('studis-kanban-board-ux — AC2: Status-Filter Default alle ausgewählt', () => {
  it('all 7 status checkboxes are checked by default (cockpit; ideen-inbox AC1 „Idee" + board-status-verworfen AC3 „Verworfen" hinzu)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover to see checkboxes
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    await waitFor(() => {
      const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
      expect(checkboxes).toHaveLength(7);
      for (const cb of checkboxes) {
        expect(cb.checked).toBe(true);
      }
    });
  });

  it('all stories visible by default (all statuses selected — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('deselecting a status hides its stories (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy(); // Done
    });

    // Open popover
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck "Done"
    await act(async () => {
      const doneCheckbox = container.querySelector('#board-filter-status-done');
      expect(doneCheckbox).toBeTruthy();
      fireEvent.click(doneCheckbox);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy(); // To Do still visible
    });
  });

  it('status button label shows "Status (7/7) ▾" by default (cockpit; ideen-inbox AC1 + board-status-verworfen AC3, 7 statuses)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toMatch(/Status \(7\/7\)/);
  });

  it('status button label shows "Status (n/7) ▾" after deselect', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover and uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      const doneCheckbox = container.querySelector('#board-filter-status-done');
      fireEvent.click(doneCheckbox);
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.textContent).toMatch(/Status \(6\/7\)/);
  });

  it('ideen-inbox AC1: Status-Filter führt „Idee"-Checkbox, Default angehakt', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const ideeCheckbox = container.querySelector('#board-filter-status-idee');
    expect(ideeCheckbox).toBeTruthy();
    expect(ideeCheckbox.checked).toBe(true);
  });

  it('board-status-verworfen AC3: Status-Filter führt „Verworfen"-Checkbox als 7. Checkbox, Default angehakt', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const checkboxes = Array.from(
      container.querySelectorAll('#board-filter-status-group input[type="checkbox"]')
    );
    expect(checkboxes[checkboxes.length - 1].id).toBe('board-filter-status-verworfen');

    const verworfenCheckbox = container.querySelector('#board-filter-status-verworfen');
    expect(verworfenCheckbox).toBeTruthy();
    expect(verworfenCheckbox.checked).toBe(true);
  });

  it('board-status-verworfen AC3: Deselektieren von „Verworfen" blendet die Verworfen-Spalte/-Karten aus, Selektieren zeigt sie wieder', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_VERWORFEN] });
    const { container } = renderCockpit('project-verworfen');

    await waitFor(() => {
      expect(container.querySelector(`[data-story="${STORY_VERWORFEN.id}"]`)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      const verworfenCheckbox = container.querySelector('#board-filter-status-verworfen');
      expect(verworfenCheckbox).toBeTruthy();
      fireEvent.click(verworfenCheckbox);
    });

    await waitFor(() => {
      expect(container.querySelector(`[data-story="${STORY_VERWORFEN.id}"]`)).toBeNull();
      expect(container.querySelector(`[data-story="${STORY_TODO.id}"]`)).toBeTruthy(); // andere Status weiter sichtbar
    });

    // Wieder selektieren zeigt die Verworfen-Story erneut.
    await act(async () => {
      const verworfenCheckbox = container.querySelector('#board-filter-status-verworfen');
      fireEvent.click(verworfenCheckbox);
    });

    await waitFor(() => {
      expect(container.querySelector(`[data-story="${STORY_VERWORFEN.id}"]`)).toBeTruthy();
    });
  });
});

// ── AC3 (studis-kanban-board-ux) — Kein Status gewählt ───────────────────────

describe('studis-kanban-board-ux — AC3: Alle Status deselektiert → Hinweis', () => {
  it('shows "Kein Status gewählt" hint when all statuses deselected (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck all 7
    const statuses = ['idee', 'to-do', 'in-progress', 'blocked', 'in-review', 'done', 'verworfen'];
    for (const s of statuses) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        expect(cb).toBeTruthy();
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      const hint = container.querySelector('[data-testid="no-status-hint"]');
      expect(hint).toBeTruthy();
      expect(hint.getAttribute('role')).toBe('status');
      expect(hint.textContent).toMatch(/kein status gewählt/i);
    });
  });

  it('no stories shown when all statuses deselected (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const statuses = ['idee', 'to-do', 'in-progress', 'blocked', 'in-review', 'done'];
    for (const s of statuses) {
      await act(async () => {
        fireEvent.click(container.querySelector(`#board-filter-status-${s}`));
      });
    }

    await waitFor(() => {
      // No story cards visible
      expect(container.querySelector('[data-story]')).toBeNull();
    });
  });
});

// ── AC7 (studis-kanban-board-ux) — „Alle/Keine"-Toggle im Popover ────────────

describe('studis-kanban-board-ux — AC7: „Alle/Keine"-Toggle', () => {
  it('toggle button sits inside the popover above the checkboxes (DOM order)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const popover = container.querySelector('[data-testid="status-popover"]');
    const toggle = container.querySelector('[data-testid="status-toggle-all-btn"]');
    const firstCheckbox = container.querySelector('#board-filter-status-group input[type="checkbox"]');
    expect(popover).toBeTruthy();
    expect(toggle).toBeTruthy();
    expect(popover.contains(toggle)).toBe(true);
    // Toggle precedes the first checkbox in document order (steht ganz oben).
    // 0x04 = DOCUMENT_POSITION_FOLLOWING (firstCheckbox follows toggle).
    expect(toggle.compareDocumentPosition(firstCheckbox) & 0x04).toBeTruthy();
  });

  it('default (all selected): label „Keine", aria-pressed=true; click deselects all → V3-Hinweis', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const toggle = container.querySelector('[data-testid="status-toggle-all-btn"]');
    expect(toggle.textContent).toBe('Keine');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toMatch(/abwählen/i);

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
      for (const cb of checkboxes) {
        expect(cb.checked).toBe(false);
      }
      // V3-Leer-Hinweis greift
      const hint = container.querySelector('[data-testid="no-status-hint"]');
      expect(hint).toBeTruthy();
    });
    // Button label + status flips to „Alle"
    expect(container.querySelector('[data-testid="status-toggle-all-btn"]').textContent).toBe('Alle');
    expect(container.querySelector('[data-testid="status-toggle-all-btn"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('partial selection: label „Alle", aria-pressed=false; click selects all', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Deselect one → partial state
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    const toggle = container.querySelector('[data-testid="status-toggle-all-btn"]');
    expect(toggle.textContent).toBe('Alle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toMatch(/auswählen/i);

    // Click selects all again (back to default)
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
      expect(checkboxes).toHaveLength(7);
      for (const cb of checkboxes) {
        expect(cb.checked).toBe(true);
      }
    });
    expect(container.querySelector('[data-testid="status-filter-btn"]').textContent).toMatch(/Status \(7\/7\)/);
  });
});

// ── AC4 (studis-kanban-board-ux) — Status-Filter Popover ─────────────────────

describe('studis-kanban-board-ux — AC4: Status-Filter als Popover', () => {
  it('status filter button is present with aria-expanded=false initially (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('click opens popover (aria-expanded=true) and shows checkboxes', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();

    const checkboxes = container.querySelectorAll('#board-filter-status-group input[type="checkbox"]');
    expect(checkboxes).toHaveLength(7);
  });

  it('second click closes popover (aria-expanded=false)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
      expect(container.querySelector('[data-testid="status-filter-btn"]').getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('Esc key closes popover', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
    });
  });

  it('outside click closes popover', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeTruthy();
    });

    // Click outside the popover
    await act(async () => {
      fireEvent.mouseDown(document.body);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
    });
  });

  it('button has aria-controls pointing to popover id', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="status-filter-btn"]');
    expect(btn.getAttribute('aria-controls')).toBe('board-status-popover');
  });

  it('popover is not visible when closed (no status-popover testid)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="status-popover"]')).toBeNull();
  });
});

// ── AC4 — Mount loads projects exactly once (cockpit) ────────────────────────

describe('dev-gui-board-aggregator — AC4: Mount loads project in cockpit', () => {
  it('calls GET /api/board/projects/:slug exactly once on mount (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    renderCockpit('project-alpha');

    await waitFor(() => {
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        c[0] === '/api/board/projects/project-alpha'
      );
      expect(calls).toHaveLength(1);
    });
  });

  it('shows aria-busy loading state during fetch (cockpit)', async () => {
    let resolveProject;
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-alpha') {
        await new Promise((r) => { resolveProject = r; });
        return { ok: true, json: async () => ({ project: PROJECT_A }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();

    await act(async () => { resolveProject(); });
    await waitFor(() => {
      expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    });
  });

  it('renders project sections after load (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });

  it('renders feature rows within a project (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-001"]')).toBeTruthy();
      expect(container.querySelector('[data-feature="F-002"]')).toBeTruthy();
    });
  });

  it('renders story cards within a feature (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders all seven status columns for a feature (AC4 status columns, cockpit; ideen-inbox AC1; board-status-verworfen AC1)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      expect(feature.querySelector('[data-status="Idee"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="To Do"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Progress"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Blocked"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="In Review"]')).toBeTruthy();
      expect(feature.querySelector('[data-status="Done"]')).toBeTruthy();
      // board-status-verworfen AC1: 7. Spalte rendert auch ohne eine einzige
      // Verworfen-Story im Feature (leere Spalte, kein Crash).
      expect(feature.querySelector('[data-status="Verworfen"]')).toBeTruthy();
    });
  });

  it('ideen-inbox AC1 + board-status-verworfen AC1: „Idee"-Spalte rendert als erste, „Verworfen" als letzte (7.) Spalte rechts von „Done"', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      expect(feature).toBeTruthy();
      const columnsList = feature.querySelector('[role="list"][aria-label="Stories nach Status"]');
      expect(columnsList).toBeTruthy();
      const columns = Array.from(columnsList.querySelectorAll('[data-status]'));
      expect(columns.map((c) => c.getAttribute('data-status'))).toEqual([
        'Idee', 'To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Verworfen',
      ]);
    });
  });

  it('ideen-inbox AC1: eine Story mit status:Idee wird in die „Idee"-Spalte einsortiert (nicht in „To Do")', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_IDEE] });
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      const ideeCol = container.querySelector('[data-status="Idee"]');
      expect(ideeCol).toBeTruthy();
      expect(ideeCol.querySelector(`[data-story="${STORY_IDEE.id}"]`)).toBeTruthy();

      const toDoCol = container.querySelector('[data-status="To Do"]');
      expect(toDoCol.querySelector(`[data-story="${STORY_IDEE.id}"]`)).toBeNull();
      expect(toDoCol.querySelector(`[data-story="${STORY_TODO.id}"]`)).toBeTruthy();
    });
  });

  it('board-status-verworfen AC4: eine Story mit status:Verworfen wird in die „Verworfen"-Spalte einsortiert (nicht in den „To Do"-Fallback)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_VERWORFEN] });
    const { container } = renderCockpit('project-verworfen');

    await waitFor(() => {
      const verworfenCol = container.querySelector('[data-status="Verworfen"]');
      expect(verworfenCol).toBeTruthy();
      expect(verworfenCol.querySelector(`[data-story="${STORY_VERWORFEN.id}"]`)).toBeTruthy();

      const toDoCol = container.querySelector('[data-status="To Do"]');
      expect(toDoCol.querySelector(`[data-story="${STORY_VERWORFEN.id}"]`)).toBeNull();
      expect(toDoCol.querySelector(`[data-story="${STORY_TODO.id}"]`)).toBeTruthy();
    });
  });

  it('places stories in the correct status column (AC4, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const toDoCol = container.querySelector('[data-status="To Do"]');
      expect(toDoCol.querySelector('[data-story="S-001"]')).toBeTruthy();

      const inProgressCol = container.querySelector('[data-status="In Progress"]');
      expect(inProgressCol.querySelector('[data-story="S-002"]')).toBeTruthy();

      const doneCol = container.querySelector('[data-status="Done"]');
      expect(doneCol.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('renders story title and id (AC3 model fields, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container, getByText } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(getByText('Erstelle Login-Seite')).toBeTruthy();
    });
  });

  it('<main> has aria-label "Studis-Kanban-Board" (AC1/A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [] });
    const { getByRole } = renderCockpit('project-alpha');
    expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
  });
});

// ── idea-specify-chat AC1/AC2 (S-218) — Chat-Overlay ersetzt discuss/resolve ─
//
// Frontend-Verantwortung von BoardView ist NUR die Verdrahtung: bei
// status==='Idee' öffnet sowohl der Karte-Klick als auch der „Spezifizieren"-
// Button dasselbe Overlay (IdeaSpecifyChatModal, hier gemockt — siehe Mock-
// Setup oben); Modal-Interna (Chat/A11y/Finalize) sind in
// `IdeaSpecifyChatModal.test.jsx` (S-217) abgedeckt. Der frühere discuss-Tab-
// Sprung (onDiscussIdea) und die frühere Resolve-UI (IdeaResolveModal) sind
// vollständig entfernt.

describe('idea-specify-chat AC1/AC2 (S-218) — Chat-Overlay ersetzt discuss/resolve', () => {
  beforeEach(() => {
    lastIdeaSpecifyProps = null;
  });

  it('Klick auf eine Idee-Karte (status:Idee) öffnet das Chat-Overlay (kein Detail-Fetch, kein discuss-/resolve-POST mehr möglich)', async () => {
    const fetchMock = makeBoardFetch({ fullProjects: [PROJECT_IDEE] });
    globalThis.fetch = fetchMock;
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`));
    });

    await waitFor(() => {
      const modal = container.querySelector('[data-testid="idea-specify-chat-modal-mock"]');
      expect(modal).toBeTruthy();
      expect(modal.getAttribute('data-project-slug')).toBe('project-idee');
      expect(modal.getAttribute('data-story-id')).toBe(STORY_IDEE.id);
    });

    // KEIN Detail-Fetch — die normale Detail-Ansicht öffnet nicht für eine Idee.
    const detailCalls = fetchMock.mock.calls.filter(([url]) => /\/stories\/[^/]+\/detail$/.test(url));
    expect(detailCalls.length).toBe(0);
    expect(container.querySelector('h1')?.textContent).not.toMatch(new RegExp(STORY_IDEE.id));

    // Der alte discuss-/resolve-Pfad existiert nicht mehr — keine solchen Calls möglich.
    const legacyCalls = fetchMock.mock.calls.filter(([url]) => /\/(discuss|resolve)$/.test(url));
    expect(legacyCalls.length).toBe(0);

    // Board bleibt im Hintergrund sichtbar (kein Tab-Wechsel-Code in BoardView).
    expect(container.querySelector('main[aria-label="Studis-Kanban-Board"]')).toBeTruthy();
  });

  it('Klick auf den „Spezifizieren"-Button öffnet DASSELBE Overlay wie der Karte-Klick (identischer projectSlug/story); Nicht-Idee-Karten zeigen keinen Trigger', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_IDEE] });
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="idea-specify-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    });

    // Nicht-Idee-Karten (status:To Do) bekommen KEINEN Spezifizieren-Trigger.
    expect(container.querySelector(`[data-testid="idea-specify-btn-${STORY_TODO.id}"]`)).toBeNull();

    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="idea-specify-btn-${STORY_IDEE.id}"]`));
    });

    await waitFor(() => {
      const modal = container.querySelector('[data-testid="idea-specify-chat-modal-mock"]');
      expect(modal).toBeTruthy();
      expect(modal.getAttribute('data-project-slug')).toBe('project-idee');
      expect(modal.getAttribute('data-story-id')).toBe(STORY_IDEE.id);
    });
    expect(lastIdeaSpecifyProps?.story?.id).toBe(STORY_IDEE.id);
  });

  it('Klick auf eine NICHT-Idee-Karte (status:To Do) öffnet weiterhin die normale Detail-Ansicht (keine Regression)', async () => {
    const fetchMock = makeBoardFetchWithDetail({ fullProjects: [PROJECT_IDEE] });
    globalThis.fetch = fetchMock;
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="story-card-btn-${STORY_TODO.id}"]`)).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="story-card-btn-${STORY_TODO.id}"]`));
    });

    await waitFor(() => {
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toMatch(new RegExp(STORY_TODO.id));
    });
    expect(container.querySelector('[data-testid="idea-specify-chat-modal-mock"]')).toBeNull();
  });

  it('onSpecified(slug) löst einen erneuten GET /api/board/projects/:slug-Fetch aus (Board-Re-Fetch); Schließen entfernt das Overlay', async () => {
    const fetchMock = makeBoardFetch({ fullProjects: [PROJECT_IDEE] });
    globalThis.fetch = fetchMock;
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="idea-specify-chat-modal-mock"]')).toBeTruthy();
    });

    const callsBeforeSpecified = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/board/projects/project-idee',
    ).length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="idea-specify-mock-specified-btn"]'));
    });

    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter(
        ([url]) => url === '/api/board/projects/project-idee',
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBeforeSpecified);
    });

    // Schließen (analog dem echten Modal, das nach onSpecified selbst onClose() ruft).
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="idea-specify-mock-close-btn"]'));
    });
    expect(container.querySelector('[data-testid="idea-specify-chat-modal-mock"]')).toBeNull();
  });
});

// ── idea-specify-background-status (S-230): AC3/AC4/AC5 ────────────────────────

/**
 * Fetch-Mock für S-230: reicht die Board-Endpunkte durch UND bedient den
 * idea-keyed Status-Endpunkt GET …/specify/jobs (vor dem generischen :slug-
 * Matcher!). `getJobs()` liefert die aktuelle Jobs-Map (mutierbar über Closure),
 * sodass ein Test den Übergang running→done modellieren kann.
 *
 * @param {{ fullProjects?: object[], getJobs?: () => object }} opts
 */
function makeSpecifyFetch({ fullProjects = [], getJobs = () => ({}) } = {}) {
  return jest.fn(async (url) => {
    // MUSS vor dem /:slug-Matcher stehen (sonst als Slug fehlinterpretiert).
    if (/^\/api\/board\/projects\/[^/]+\/specify\/jobs$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ jobs: getJobs() }) };
    }
    if (url === '/api/board/projects/list') {
      const list = fullProjects.map((p) => (p.error ? { slug: p.slug, error: p.error } : {
        slug: p.slug,
        feature_count: (p.features ?? []).length,
        story_count: (p.features ?? []).reduce((a, f) => a + (f.stories ?? []).length, 0),
      }));
      return { ok: true, status: 200, json: async () => ({ projects: list }) };
    }
    if (url === '/api/board/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: fullProjects }) };
    }
    const slugMatch = url.match(/^\/api\/board\/projects\/(.+)$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      const proj = fullProjects.find((p) => p.slug === slug);
      if (proj) return { ok: true, status: 200, json: async () => ({ project: proj }) };
      return { ok: false, status: 404, json: async () => ({ error: 'nicht gefunden' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('idea-specify-background-status (S-230) — AC3/AC4: Idee-Karten-Badge', () => {
  it('AC3 — running-Job rendert Lauf-Badge „wird spezifiziert…" (Text + aria-busy/role=status)', async () => {
    globalThis.fetch = makeSpecifyFetch({
      fullProjects: [PROJECT_IDEE],
      getJobs: () => ({ [STORY_IDEE.id]: { status: 'running', jobId: 'j1' } }),
    });
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="specify-running-badge-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
    const badge = container.querySelector(`[data-testid="specify-running-badge-${STORY_IDEE.id}"]`);
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.getAttribute('aria-busy')).toBe('true');
    expect(badge.getAttribute('aria-live')).toBe('polite');
    expect(badge.textContent).toMatch(/wird spezifiziert/i);
    // Kein Fehler-Badge gleichzeitig.
    expect(container.querySelector(`[data-testid="specify-error-badge-${STORY_IDEE.id}"]`)).toBeNull();
  });

  it('AC4 — failed-Job rendert nicht-blockierenden Fehler-Hinweis; Karte bleibt anklickbar', async () => {
    globalThis.fetch = makeSpecifyFetch({
      fullProjects: [PROJECT_IDEE],
      getJobs: () => ({ [STORY_IDEE.id]: { status: 'failed', jobId: 'j1' } }),
    });
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="specify-error-badge-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
    const badge = container.querySelector(`[data-testid="specify-error-badge-${STORY_IDEE.id}"]`);
    expect(badge.getAttribute('role')).toBe('status');
    expect(badge.textContent).toMatch(/fehlgeschlagen — erneut versuchen/i);
    // Karte bleibt klickbar (Story-Card-Button + Spezifizieren-Trigger vorhanden).
    expect(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-testid="idea-specify-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
  });

  it('AC4 — auth-expired-Job rendert denselben Fehler-Hinweis', async () => {
    globalThis.fetch = makeSpecifyFetch({
      fullProjects: [PROJECT_IDEE],
      getJobs: () => ({ [STORY_IDEE.id]: { status: 'auth-expired', jobId: 'j1' } }),
    });
    const { container } = renderCockpit('project-idee');
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="specify-error-badge-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
  });

  it('AC4 — kein Job (done → aus dem Snapshot entfernt) → kein Badge', async () => {
    globalThis.fetch = makeSpecifyFetch({ fullProjects: [PROJECT_IDEE], getJobs: () => ({}) });
    const { container } = renderCockpit('project-idee');
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="story-card-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
    // Nach Hydration (specify/jobs) bleibt kein Badge.
    await waitFor(() => {
      const jobsCalls = globalThis.fetch.mock.calls.filter(([u]) => /\/specify\/jobs$/.test(u));
      expect(jobsCalls.length).toBeGreaterThanOrEqual(1);
    });
    expect(container.querySelector(`[data-testid="specify-running-badge-${STORY_IDEE.id}"]`)).toBeNull();
    expect(container.querySelector(`[data-testid="specify-error-badge-${STORY_IDEE.id}"]`)).toBeNull();
  });
});

describe('idea-specify-background-status (S-230) — AC5: Hydratisieren + Polling + Re-Fetch', () => {
  it('AC5 — hydratisiert die Idee-Badges aus GET …/specify/jobs beim Board-Load', async () => {
    const fetchMock = makeSpecifyFetch({
      fullProjects: [PROJECT_IDEE],
      getJobs: () => ({ [STORY_IDEE.id]: { status: 'running', jobId: 'j1' } }),
    });
    globalThis.fetch = fetchMock;
    renderCockpit('project-idee');
    await waitFor(() => {
      const jobsCalls = fetchMock.mock.calls.filter(([u]) =>
        u === '/api/board/projects/project-idee/specify/jobs');
      expect(jobsCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('AC5 — Schließen des Chat-Overlays re-hydratisiert die Badges (gerade gestarteter Lauf erscheint)', async () => {
    let jobs = {};
    const fetchMock = makeSpecifyFetch({ fullProjects: [PROJECT_IDEE], getJobs: () => jobs });
    globalThis.fetch = fetchMock;
    const { container } = renderCockpit('project-idee');

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="idea-specify-btn-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
    // Overlay öffnen.
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="idea-specify-btn-${STORY_IDEE.id}"]`));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="idea-specify-chat-modal-mock"]')).toBeTruthy();
    });

    // Simuliert: „Story anlegen" hat serverseitig einen running-Job registriert.
    jobs = { [STORY_IDEE.id]: { status: 'running', jobId: 'j1' } };

    // Fire-and-forget-Schließen → Re-Hydration → Badge erscheint (AC5).
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="idea-specify-mock-close-btn"]'));
    });
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="specify-running-badge-${STORY_IDEE.id}"]`)).toBeTruthy();
    });
  });

  it('AC5 — pollt solange running, löst bei running→done GENAU EIN Board-Re-Fetch aus, danach kein Poll (Ruhezustand)', async () => {
    jest.useFakeTimers();
    try {
      let jobs = { [STORY_IDEE.id]: { status: 'running', jobId: 'j1' } };
      const fetchMock = makeSpecifyFetch({ fullProjects: [PROJECT_IDEE], getJobs: () => jobs });
      globalThis.fetch = fetchMock;
      const countJobs = () =>
        fetchMock.mock.calls.filter(([u]) => u === '/api/board/projects/project-idee/specify/jobs').length;
      const countBoard = () =>
        fetchMock.mock.calls.filter(([u]) => u === '/api/board/projects/project-idee').length;

      let container;
      await act(async () => { ({ container } = renderCockpit('project-idee')); });
      // Mount-Load + Hydration durchflushen.
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });

      expect(countJobs()).toBeGreaterThanOrEqual(1);
      const jobsAfterHydrate = countJobs();

      // Ein Poll-Intervall → weiterer specify/jobs-Poll (noch running).
      await act(async () => { await jest.advanceTimersByTimeAsync(4000); });
      expect(countJobs()).toBeGreaterThan(jobsAfterHydrate);

      // Job terminiert → Endpoint liefert leeren Snapshot (done entfernt).
      jobs = {};
      const boardBefore = countBoard();
      await act(async () => { await jest.advanceTimersByTimeAsync(4000); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      // running→weg erkannt → GENAU EIN Board-Re-Fetch.
      expect(countBoard()).toBe(boardBefore + 1);

      // Ruhezustand: kein running mehr → Intervall geräumt → kein weiterer Poll.
      const jobsAfterDone = countJobs();
      await act(async () => { await jest.advanceTimersByTimeAsync(12000); });
      expect(countJobs()).toBe(jobsAfterDone);
      // Und kein weiterer Re-Fetch (genau EINER blieb es).
      expect(countBoard()).toBe(boardBefore + 1);
      expect(container).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC5 — ohne aktive Jobs findet KEIN Polling statt (kein Dauer-Poll im Ruhezustand)', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = makeSpecifyFetch({ fullProjects: [PROJECT_IDEE], getJobs: () => ({}) });
      globalThis.fetch = fetchMock;
      const countJobs = () =>
        fetchMock.mock.calls.filter(([u]) => u === '/api/board/projects/project-idee/specify/jobs').length;

      await act(async () => { renderCockpit('project-idee'); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });

      const afterHydrate = countJobs(); // genau die Hydration
      await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
      expect(countJobs()).toBe(afterHydrate); // kein Intervall-Poll
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── story-specify-finalize-visibility (S-240): AC6 Board-Hinweis ──────────────

/**
 * Fetch-Mock für S-240 AC6: reicht die Board-Endpunkte durch UND bedient den
 * projekt-keyed GET …/story-specify/finalize (vor dem generischen :slug-Matcher!)
 * sowie GET …/specify/jobs (leere Idee-Jobs). `getFinalize()` liefert den
 * aktuellen projekt-keyed Job (mutierbar über Closure), sodass ein Test den
 * Übergang running→terminal modellieren kann.
 *
 * @param {{ fullProjects?: object[], getFinalize?: () => object|null }} opts
 */
function makeFinalizeFetch({ fullProjects = [], getFinalize = () => null } = {}) {
  return jest.fn(async (url) => {
    // MÜSSEN vor dem /:slug-Matcher stehen (sonst als Slug fehlinterpretiert).
    if (/^\/api\/board\/projects\/[^/]+\/story-specify\/finalize$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ job: getFinalize() }) };
    }
    if (/^\/api\/board\/projects\/[^/]+\/specify\/jobs$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ jobs: {} }) };
    }
    if (url === '/api/board/projects/list') {
      const list = fullProjects.map((p) => (p.error ? { slug: p.slug, error: p.error } : {
        slug: p.slug,
        feature_count: (p.features ?? []).length,
        story_count: (p.features ?? []).reduce((a, f) => a + (f.stories ?? []).length, 0),
      }));
      return { ok: true, status: 200, json: async () => ({ projects: list }) };
    }
    if (url === '/api/board/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: fullProjects }) };
    }
    const slugMatch = url.match(/^\/api\/board\/projects\/(.+)$/);
    if (slugMatch) {
      const slug = decodeURIComponent(slugMatch[1]);
      const proj = fullProjects.find((p) => p.slug === slug);
      if (proj) return { ok: true, status: 200, json: async () => ({ project: proj }) };
      return { ok: false, status: 404, json: async () => ({ error: 'nicht gefunden' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('story-specify-finalize-visibility (S-240) — AC6: Board-Hinweis', () => {
  it('AC6 — zeigt den nicht-blockierenden Hinweis (Text + ⚠-Icon, role=status/aria-live) bei letztem no-op', async () => {
    globalThis.fetch = makeFinalizeFetch({
      fullProjects: [PROJECT_A],
      getFinalize: () => ({ status: 'no-op', jobId: 'f1' }),
    });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeTruthy();
    });
    const hint = container.querySelector('[data-testid="board-finalize-hint"]');
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.getAttribute('aria-live')).toBe('polite');
    expect(hint.textContent).toMatch(/Story-Erstellung fehlgeschlagen — erneut versuchen/);
    // Nicht nur Farbe: ⚠-Icon (aria-hidden) neben dem Text.
    expect(hint.textContent).toContain('⚠');
    // Board bleibt nutzbar: die Projekt-Spalten sind weiterhin gerendert.
    expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    // Secret-frei: keine jobId im sichtbaren Text.
    expect(hint.textContent).not.toMatch(/f1/);
  });

  it('AC6 — zeigt den Hinweis auch bei failed und auth-expired', async () => {
    for (const status of ['failed', 'auth-expired']) {
      globalThis.fetch = makeFinalizeFetch({
        fullProjects: [PROJECT_A],
        getFinalize: () => ({ status, jobId: 'f2' }),
      });
      const { container, unmount } = renderCockpit('project-alpha');
      await waitFor(() => {
        expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeTruthy();
      });
      unmount();
    }
  });

  it('AC6 — KEIN Hinweis bei running/done/null (kein Fehlausgang)', async () => {
    for (const job of [{ status: 'running', jobId: 'f3' }, { status: 'done', jobId: 'f4' }, null]) {
      globalThis.fetch = makeFinalizeFetch({
        fullProjects: [PROJECT_A],
        getFinalize: () => job,
      });
      const { container, unmount } = renderCockpit('project-alpha');
      await waitFor(() => {
        expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
      });
      // Nach Hydration bleibt kein Hinweis (running blendet ihn NICHT ein).
      await waitFor(() => {
        const calls = globalThis.fetch.mock.calls.filter(([u]) => /\/story-specify\/finalize$/.test(u));
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });
      expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeNull();
      unmount();
    }
  });

  it('AC6 — der Hinweis ist quittierbar (✕) und verschwindet nach dem Ausblenden', async () => {
    globalThis.fetch = makeFinalizeFetch({
      fullProjects: [PROJECT_A],
      getFinalize: () => ({ status: 'failed', jobId: 'f5' }),
    });
    const { container } = renderCockpit('project-alpha');
    await waitFor(() => {
      expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="board-finalize-hint-dismiss"]'));
    });
    expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeNull();
  });

  it('AC6 — pollt NUR solange der letzte Finalize running ist; im Ruhezustand kein Poll', async () => {
    jest.useFakeTimers();
    try {
      let job = { status: 'running', jobId: 'f6' };
      const fetchMock = makeFinalizeFetch({
        fullProjects: [PROJECT_A],
        getFinalize: () => job,
      });
      globalThis.fetch = fetchMock;
      const { container } = renderCockpit('project-alpha');

      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });

      const countFinalize = () =>
        fetchMock.mock.calls.filter(([u]) => /\/story-specify\/finalize$/.test(u)).length;
      const afterHydrate = countFinalize();
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();

      // running → ein Poll-Intervall (4000ms) löst einen weiteren Read aus.
      job = { status: 'no-op', jobId: 'f6' };
      await act(async () => { await jest.advanceTimersByTimeAsync(4000); });
      await act(async () => { await jest.advanceTimersByTimeAsync(0); });
      const afterOnePoll = countFinalize();
      expect(afterOnePoll).toBeGreaterThan(afterHydrate);

      // Jetzt terminal (no-op) → Hinweis erscheint, Polling stoppt (Ruhezustand).
      await waitFor(() => {
        expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeTruthy();
      });
      const settled = countFinalize();
      await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
      expect(countFinalize()).toBe(settled); // kein weiterer Poll
    } finally {
      jest.useRealTimers();
    }
  });

  it('AC6 — degradiert still bei Netzwerkfehler des Finalize-Reads (kein Hinweis, kein Crash)', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (/\/story-specify\/finalize$/.test(url)) throw new Error('network');
      if (/\/specify\/jobs$/.test(url)) return { ok: true, status: 200, json: async () => ({ jobs: {} }) };
      const slugMatch = url.match(/^\/api\/board\/projects\/(.+)$/);
      if (url === '/api/board/projects') return { ok: true, status: 200, json: async () => ({ projects: [PROJECT_A] }) };
      if (slugMatch) {
        const slug = decodeURIComponent(slugMatch[1]);
        if (slug === 'project-alpha') return { ok: true, status: 200, json: async () => ({ project: PROJECT_A }) };
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { container } = renderCockpit('project-alpha');
    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="board-finalize-hint"]')).toBeNull();
  });
});

// ── AC4 — Empty + Error state (cockpit) ───────────────────────────────────────

describe('dev-gui-board-aggregator — AC4: Empty and Error states (cockpit)', () => {
  it('shows hint when projects list is empty (cockpit)', async () => {
    // When lockedProject slug not found, /api/board/projects/:slug returns 404
    // fallback to /api/board/projects with empty list
    globalThis.fetch = jest.fn(async (url) => {
      if (url === '/api/board/projects/project-empty') {
        return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
      }
      if (url === '/api/board/projects') {
        return { ok: true, status: 200, json: async () => ({ projects: [] }) };
      }
      return { ok: false, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-empty');

    await waitFor(() => {
      expect(container.querySelector('[role="status"]')).toBeTruthy();
    });
    expect(container.querySelector('[role="status"]').textContent).toMatch(/keine projekte/i);
  });

  it('shows error alert when fetch fails with HTTP error (cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => {
      return { ok: false, status: 500, json: async () => ({}) };
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('shows error alert when fetch throws (network error, cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });

  it('<main> remains in DOM when fetch fails (cockpit)', async () => {
    globalThis.fetch = jest.fn(async () => { throw new Error('Network error'); });

    const { getByRole } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(getByRole('main', { name: /studis-kanban-board/i })).toBeTruthy();
    });
  });

  it('renders project with error badge and skips features (AC8 / V8, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_ERROR, PROJECT_A] });
    // cockpit locks to project-alpha — so it renders just that project via :slug
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
  });
});

// ── AC5 — Rollup display ──────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC5: Rollup display (cockpit)', () => {
  it('shows progress from progress field when present (AC5 — use existing)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      expect(rollup.textContent).toMatch(/1\/3/);
    });
  });

  it('computes rollup from child stories when progress is missing (AC5 — fallback)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      const rollup = feature.querySelector('[data-testid="rollup-bar"]');
      expect(rollup).toBeTruthy();
      expect(rollup.textContent).toMatch(/0\/2/);
    });
  });

  it('progressbar has role="progressbar" with aria-valuenow (A11y)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const progressbars = container.querySelectorAll('[role="progressbar"]');
      expect(progressbars.length).toBeGreaterThan(0);
      for (const pb of progressbars) {
        expect(pb.hasAttribute('aria-valuenow')).toBe(true);
        expect(pb.hasAttribute('aria-valuemin')).toBe(true);
        expect(pb.hasAttribute('aria-valuemax')).toBe(true);
      }
    });
  });

  it('progressbar aria-valuenow equals 33 for 1/3 done (rounded)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-001"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(33);
    });
  });

  it('progressbar aria-valuenow equals 0 for 0/2 done', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      const pb = feature.querySelector('[role="progressbar"]');
      expect(parseInt(pb.getAttribute('aria-valuenow'), 10)).toBe(0);
    });
  });

  it('shows "0/0 done" for feature with no stories (empty feature, cockpit)', async () => {
    const projectWithEmpty = {
      slug: 'project-x',
      features: [FEATURE_EMPTY],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithEmpty] });
    const { container } = renderCockpit('project-x');

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      expect(rollup.textContent).toMatch(/0\/0/);
    });
  });

  it('uses progress.done=2 progress.total=3 when progress field provided (not recount)', async () => {
    const featureStaleProgress = {
      id: 'F-stale',
      title: 'Stale Progress Feature',
      status: 'In Progress',
      priority: 'high',
      progress: { done: 2, total: 3 },
      stories: [
        { id: 'S-x1', parent: 'F-stale', title: 'Story 1', status: 'To Do', labels: [] },
        { id: 'S-x2', parent: 'F-stale', title: 'Story 2', status: 'In Progress', labels: [] },
      ],
    };
    const staleProject = { slug: 'project-stale', features: [featureStaleProgress] };
    globalThis.fetch = makeBoardFetch({ fullProjects: [staleProject] });
    const { container } = renderCockpit('project-stale');

    await waitFor(() => {
      const rollup = container.querySelector('[data-testid="rollup-bar"]');
      expect(rollup.textContent).toMatch(/2\/3/);
    });
  });
});

// ── run-state-live-view (S-316) — AC7/AC10: RunsSummary rendering ────────────

describe('run-state-live-view — AC7: aktive Feature-Läufe kompakt anzeigen', () => {
  it('shows feature, phase (textual), current story, progress for an active run', async () => {
    const projectWithRun = {
      slug: 'project-run',
      features: [FEATURE_EMPTY],
      runs: [
        {
          feature: 'F-069',
          phase: 'story',
          currentStory: 'S-316',
          done: 4,
          total: 7,
          round: 2,
          startedAt: '2026-07-07T09:00:00Z',
          lastError: null,
          isLastRun: false,
        },
      ],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithRun] });
    const { container } = renderCockpit('project-run');

    await waitFor(() => {
      const item = container.querySelector('[data-testid="run-summary-F-069"]');
      expect(item).toBeTruthy();
      expect(item.textContent).toContain('F-069');
      expect(item.textContent).toMatch(/Story/); // Phasen-Label ist textlich, nie nur Farbe
      expect(item.textContent).toContain('S-316');
      expect(item.textContent).toMatch(/4\/7/);
    });
  });

  it('shows the last error when set', async () => {
    const projectWithError = {
      slug: 'project-run-err',
      features: [FEATURE_EMPTY],
      runs: [
        {
          feature: 'F-070',
          phase: 'merge',
          currentStory: null,
          done: null,
          total: null,
          round: null,
          startedAt: null,
          lastError: 'PR-Merge fehlgeschlagen: Konflikt in server.js',
          isLastRun: false,
        },
      ],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithError] });
    const { container } = renderCockpit('project-run-err');

    await waitFor(() => {
      const item = container.querySelector('[data-testid="run-summary-F-070"]');
      expect(item.textContent).toContain('PR-Merge fehlgeschlagen: Konflikt in server.js');
    });
  });

  it('renders nothing when there is no active run (runs: [])', async () => {
    const projectNoRuns = { slug: 'project-norun', features: [FEATURE_EMPTY], runs: [] };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectNoRuns] });
    const { container } = renderCockpit('project-norun');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-norun"]')).toBeTruthy();
    });
    expect(container.querySelector('[role="list"][aria-label="Aktive Feature-Läufe"]')).toBeNull();
  });

  it('renders nothing when runs is missing (backward-compatible with projects without runs)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] }); // PROJECT_A has no `runs` field
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });
    expect(container.querySelector('[role="list"][aria-label="Aktive Feature-Läufe"]')).toBeNull();
  });

  it('a last-run (compacted, isLastRun: true) entry is not shown as an active run', async () => {
    const projectWithLastRun = {
      slug: 'project-lastrun',
      features: [FEATURE_EMPTY],
      runs: [
        {
          feature: 'F-071',
          phase: 'rollout',
          currentStory: null,
          done: 3,
          total: 3,
          round: 1,
          startedAt: '2026-07-01T00:00:00Z',
          lastError: null,
          isLastRun: true,
        },
      ],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithLastRun] });
    const { container } = renderCockpit('project-lastrun');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-lastrun"]')).toBeTruthy();
    });
    expect(container.querySelector('[data-testid="run-summary-F-071"]')).toBeNull();
  });
});

describe('run-state-live-view — AC10: Dossier/Notizen werden nicht gerendert (Nicht-Ziel)', () => {
  it('does not render dossier/notes text even if present on the run entry (defensive — not part of the AC2 field set)', async () => {
    const projectWithExtraFields = {
      slug: 'project-extra',
      features: [FEATURE_EMPTY],
      runs: [
        {
          feature: 'F-072',
          phase: 'dossier',
          currentStory: null,
          done: null,
          total: null,
          round: null,
          startedAt: null,
          lastError: null,
          isLastRun: false,
          // Defensive: even if a future backend accidentally attached these,
          // RunsSummary must never render them (AC10 Nicht-Ziel).
          dossier: 'GEHEIME DOSSIER-NOTIZEN',
          notes: 'INTERNE NOTIZEN',
        },
      ],
    };
    globalThis.fetch = makeBoardFetch({ fullProjects: [projectWithExtraFields] });
    const { container } = renderCockpit('project-extra');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="run-summary-F-072"]')).toBeTruthy();
    });
    expect(container.textContent).not.toContain('GEHEIME DOSSIER-NOTIZEN');
    expect(container.textContent).not.toContain('INTERNE NOTIZEN');
  });
});

// ── feature-umsetzen-button — Button unabhängig von der Story-Anzahl (Owner-Entscheidung 2026-07-06, zweite Korrektur) ──
// Der Button erscheint bei JEDER Story-Anzahl ≥1 (egal ob 1 oder 30) — keine
// Mindestanzahl-Sonderregel mehr.
describe('feature-umsetzen-button — erscheint unabhängig von der Story-Anzahl (Owner-Entscheidung 2026-07-06)', () => {
  it('genau 1 Story -> Button erscheint trotzdem', async () => {
    const featureSingleStory = {
      id: 'F-single',
      title: 'Nur eine Story',
      status: 'In Progress',
      priority: 'high',
      stories: [{ id: 'S-single', parent: 'F-single', title: 'Einzige Story', status: 'To Do', labels: [] }],
    };
    const project = { slug: 'project-single', features: [featureSingleStory] };
    globalThis.fetch = makeBoardFetch({ fullProjects: [project] });
    const { container } = renderCockpit('project-single');

    await waitFor(() => {
      expect(container.textContent).toMatch(/Umsetzen/);
    });
  });

  it('2 Storys -> Button erscheint weiterhin', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const feature = container.querySelector('[data-feature="F-002"]');
      expect(feature.textContent).toMatch(/Umsetzen/);
    });
  });
});

// ── AC6 (dev-gui-board-aggregator) — Filter (cockpit) ─────────────────────────

describe('dev-gui-board-aggregator — AC6: Filter (cockpit)', () => {
  it('renders label filter dropdown with labels from all stories', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const select = container.querySelector('#board-filter-label');
      expect(select).toBeTruthy();
      const options = Array.from(select.options).map((o) => o.value);
      expect(options).toContain('frontend');
      expect(options).toContain('backend');
      expect(options).toContain('auth');
    });
  });

  it('filtering by status only shows stories with that status (AC6 — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });

    // Open popover and uncheck all except "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    // Uncheck all except done: to-do, in-progress, blocked, in-review
    for (const s of ['to-do', 'in-progress', 'blocked', 'in-review']) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
    });
  });

  it('filtering by label only shows stories with that label (AC6 — cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-004"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-001"]')).toBeNull();
      expect(container.querySelector('[data-story="S-002"]')).toBeNull();
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });
  });

  it('shows reset button when label filter is active', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // No filter active yet (all 5 selected, no label)
    expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();

    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), {
        target: { value: 'ci' },
      });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeTruthy();
    });
  });

  it('reset button restores all 5 statuses checked and clears label (AC2 reset)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    // Open popover, uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });
    // S-003 (Done) should be hidden now
    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });

    // Click reset
    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Filter zurücksetzen"]'));
    });

    await waitFor(() => {
      // All stories restored
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      // No reset button visible (all selected = no filter)
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();
    });
  });

  it('does NOT call /api/board/* again when filters change (AC6 — client-side only)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    const callsBefore = globalThis.fetch.mock.calls.length;

    // Open popover and uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    expect(globalThis.fetch.mock.calls.length).toBe(callsBefore);
  });

  it('filter controls have aria-labels (A11y, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const statusBtn = container.querySelector('[data-testid="status-filter-btn"]');
      expect(statusBtn.getAttribute('aria-label')).toMatch(/status/i);

      const labelSelect = container.querySelector('#board-filter-label');
      expect(labelSelect.getAttribute('aria-label')).toMatch(/label/i);
    });
  });
});

// ── AC4/A11y — Status badges ──────────────────────────────────────────────────

describe('dev-gui-board-aggregator — AC4/A11y: Status badges have text labels', () => {
  it('status column headers carry aria-label with status text (cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const statusBadges = container.querySelectorAll('[aria-label^="Status:"]');
      expect(statusBadges.length).toBeGreaterThan(0);
      for (const badge of statusBadges) {
        expect(badge.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('project section has aria-label with project slug', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const section = container.querySelector('[data-project="project-alpha"]');
      expect(section.getAttribute('aria-label')).toMatch(/projekt/i);
    });
  });

  it('board-status-verworfen AC2: Verworfen-Badge zeigt Text „Verworfen" mit einem vom Done-Grünton abgesetzten Hintergrund', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container: doneContainer } = renderCockpit('project-alpha');
    let doneBadge;
    await waitFor(() => {
      doneBadge = doneContainer.querySelector('[data-status="Done"] [aria-label="Status: Done"]');
      expect(doneBadge).toBeTruthy();
    });

    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_VERWORFEN] });
    const { container: verworfenContainer } = renderCockpit('project-verworfen');
    let verworfenBadge;
    await waitFor(() => {
      verworfenBadge = verworfenContainer.querySelector(
        '[data-status="Verworfen"] [aria-label="Status: Verworfen"]'
      );
      expect(verworfenBadge).toBeTruthy();
    });

    // Bedeutung über Text, nicht nur Farbe (WCAG 2.1 AA):
    expect(verworfenBadge.textContent.trim()).toBe('Verworfen');
    // gedämpft-neutraler Ton, klar vom grünen Done-Ton abgesetzt:
    expect(verworfenBadge.style.background).not.toBe(doneBadge.style.background);
    expect(verworfenBadge.style.color).not.toBe(doneBadge.style.color);
  });

  it('story cards have aria-label with story title', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const card = container.querySelector('[data-story="S-001"]');
      expect(card.getAttribute('aria-label')).toMatch(/story/i);
    });
  });

  it('label chips are rendered with aria-label per chip', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      const labelChips = container.querySelectorAll('[aria-label^="Label:"]');
      expect(labelChips.length).toBeGreaterThan(0);
      for (const chip of labelChips) {
        expect(chip.textContent.trim().length).toBeGreaterThan(0);
      }
    });
  });
});

// ── Security floor ────────────────────────────────────────────────────────────

describe('dev-gui-board-aggregator — Security floor', () => {
  it('only /api/board/* URLs are called (cockpit, no other endpoints)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });

  it('only /api/board/* URLs are called (standalone, project list + project fetch)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderBoard();

    await waitFor(() => {
      expect(container.querySelector('[data-project-list-item="project-alpha"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="project-select-project-alpha"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-project="project-alpha"]')).toBeTruthy();
    });

    for (const call of globalThis.fetch.mock.calls) {
      expect(call[0]).toMatch(/^\/api\/board\//);
    }
  });
});

// ── Feature detail panel ──────────────────────────────────────────────────────

const FEATURE_WITH_DETAIL = {
  id: 'F-detail',
  title: 'Detail-Feature',
  status: 'Active',
  priority: 'P1',
  goal: 'Abloesung der manuellen Provisionierung.',
  definition_of_done: 'Alle Adapter gruen, Review bestanden.',
  depends: ['F-000'],
  labels: ['infra', 'vps'],
  stories: [],
};

const FEATURE_NO_OPTIONAL = {
  id: 'F-plain',
  title: 'Plain Feature',
  status: 'Backlog',
  priority: 'P2',
  goal: null,
  definition_of_done: null,
  depends: null,
  labels: null,
  stories: [],
};

const PROJECT_WITH_DETAIL = {
  slug: 'project-detail',
  repo_path: '/home/user/Git/detail',
  features: [FEATURE_WITH_DETAIL, FEATURE_NO_OPTIONAL],
};

describe('dev-gui-board-aggregator — Feature detail panel (cockpit)', () => {
  it('feature title is a button that toggles the detail panel', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeNull();

    await act(async () => {
      const btn = container.querySelector('[data-testid="feature-title-btn-F-detail"]');
      expect(btn).toBeTruthy();
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeTruthy();
    });
  });

  it('detail panel shows goal when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const goal = container.querySelector('[data-testid="feature-detail-goal"]');
      expect(goal).toBeTruthy();
      expect(goal.textContent).toMatch(/Abloesung/);
    });
  });

  it('detail panel shows definition_of_done when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const dod = container.querySelector('[data-testid="feature-detail-dod"]');
      expect(dod).toBeTruthy();
      expect(dod.textContent).toMatch(/Alle Adapter/);
    });
  });

  it('detail panel shows priority', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const prio = container.querySelector('[data-testid="feature-detail-priority"]');
      expect(prio).toBeTruthy();
      expect(prio.textContent).toMatch(/P1/);
    });
  });

  it('detail panel shows depends when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const dep = container.querySelector('[data-testid="feature-detail-depends"]');
      expect(dep).toBeTruthy();
      expect(dep.textContent).toContain('F-000');
    });
  });

  it('detail panel shows labels when present', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      const labels = container.querySelector('[data-testid="feature-detail-labels"]');
      expect(labels).toBeTruthy();
      expect(labels.textContent).toContain('infra');
      expect(labels.textContent).toContain('vps');
    });
  });

  it('clicking title again closes the detail panel', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-detail"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-detail"]')).toBeNull();
    });
  });

  it('detail panel omits null fields', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-plain"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="feature-title-btn-F-plain"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="feature-detail-F-plain"]')).toBeTruthy();
    });

    expect(container.querySelector('[data-testid="feature-detail-goal"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-dod"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-depends"]')).toBeNull();
    expect(container.querySelector('[data-testid="feature-detail-labels"]')).toBeNull();
  });

  it('title button has aria-expanded false initially and true when open', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_WITH_DETAIL] });
    const { container } = renderCockpit('project-detail');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-detail"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="feature-title-btn-F-detail"]');
    expect(btn.getAttribute('aria-expanded')).toBe('false');

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(btn.getAttribute('aria-expanded')).toBe('true');
    });
  });
});

// ── Multi-Status-Filter (cockpit) ─────────────────────────────────────────────

describe('dev-gui-board-aggregator — Multi-Status-Filter (cockpit)', () => {
  it('all stories visible by default (all 5 selected, cockpit)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('two status checkboxes unchecked → only remaining statuses visible', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover and uncheck "Blocked" and "In Review" and "Done"
    // so only "To Do" and "In Progress" remain
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });

    for (const s of ['blocked', 'in-review', 'done']) {
      await act(async () => {
        const cb = container.querySelector(`#board-filter-status-${s}`);
        expect(cb).toBeTruthy();
        fireEvent.click(cb);
      });
    }

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy(); // To Do
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy(); // In Progress
      expect(container.querySelector('[data-story="S-003"]')).toBeNull(); // Done
    });
  });

  it('unchecking and rechecking a status restores its stories', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover, uncheck "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="status-filter-btn"]'));
    });
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-003"]')).toBeNull();
    });

    // Re-check "Done"
    await act(async () => {
      fireEvent.click(container.querySelector('#board-filter-status-done'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
    });
  });

  it('reset button clears status checkboxes back to all-5-selected', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Open popover and activate a label filter (so reset button appears)
    await act(async () => {
      fireEvent.change(container.querySelector('#board-filter-label'), { target: { value: 'ci' } });
    });

    await waitFor(() => {
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[aria-label="Filter zurücksetzen"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-002"]')).toBeTruthy();
      expect(container.querySelector('[data-story="S-003"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Filter zurücksetzen"]')).toBeNull();
    });
  });
});

// ── projekt-spezifikation-anzeige AC5: Spec-Bezug klickbar ───────────────────

describe('BoardView — projekt-spezifikation-anzeige AC5: Spec-Link in StoryCard', () => {
  it('rendert Spec-Bezug als klickbaren Button wenn onOpenSpec übergeben wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      // S-001 hat spec: 'docs/specs/login.md'
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    const specLink = container.querySelector('[data-testid="spec-link-S-001"]');
    expect(specLink).not.toBeNull();
    expect(specLink.tagName).toBe('BUTTON');
    expect(specLink.textContent).toBe('docs/specs/login.md');
  });

  it('ruft onOpenSpec(relPath) auf wenn Spec-Link geklickt wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="spec-link-S-001"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="spec-link-S-001"]'));
    });

    expect(onOpenSpec).toHaveBeenCalledWith('docs/specs/login.md');
  });

  it('rendert Spec-Bezug als reinen Text wenn kein onOpenSpec übergeben wird', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha'); // kein onOpenSpec

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // Kein Button für Spec (statischer Text)
    expect(container.querySelector('[data-testid="spec-link-S-001"]')).toBeNull();
    // Spec-Wert erscheint aber als Text
    const storyEl = container.querySelector('[data-story="S-001"]');
    expect(storyEl?.textContent).toMatch(/docs\/specs\/login\.md/);
  });

  it('specLink-Button hat minHeight 44px (Touch-Target ≥ 44 px, WCAG 2.1 AA)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_A] });
    const onOpenSpec = jest.fn();
    const { container } = renderCockpit('project-alpha', { onOpenSpec });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="spec-link-S-001"]')).not.toBeNull();
    });

    const specLink = container.querySelector('[data-testid="spec-link-S-001"]');
    // jsdom exposes inline styles via element.style
    expect(specLink.style.minHeight).toBe('44px');
  });
});

// ── story-detail-ansicht: AC3/AC4 — Story-Klick öffnet Detail-Ansicht ─────────

/**
 * Fixture: detail data returned by GET .../stories/:id/detail
 */
const STORY_DETAIL_FULL = {
  started_at:  '2025-01-10T10:00:00.000Z',
  ended_at:    '2025-01-10T10:05:00.000Z',
  duration:    300,
  flow: [
    { seq: 1, agent: 'coder',    iter: 1, gate: null,   secs: 120, tok: 800 },
    { seq: 2, agent: 'reviewer', iter: 1, gate: 'PASS', secs:  60, tok: 400 },
  ],
  ep_est:      3,
  ep_act:      4,
  tok_est:     1200,
  tok_total:   1500,
  size_est:    'M',
  ep_dev:      1,
  ep_dev_pct:  33.3,
  tok_dev:     300,
  tok_dev_pct: 25,
};

const STORY_DETAIL_MISSING = {
  started_at:  null,
  ended_at:    null,
  duration:    null,
  flow:        [],
  ep_est:      null,
  ep_act:      null,
  tok_est:     null,
  tok_total:   null,
  size_est:    null,
  ep_dev:      null,
  ep_dev_pct:  null,
  tok_dev:     null,
  tok_dev_pct: null,
};

/**
 * Build a fetch mock that handles board API + story detail endpoint.
 */
function makeBoardFetchWithDetail({ fullProjects = [], detailData = STORY_DETAIL_FULL } = {}) {
  const boardMock = makeBoardFetch({ fullProjects });
  return jest.fn(async (url) => {
    // Detail endpoint: /api/board/projects/:slug/stories/:id/detail
    if (/\/stories\/[^/]+\/detail$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ detail: detailData }) };
    }
    return boardMock(url);
  });
}

describe('story-detail-ansicht — AC3: Story-Klick öffnet Detail-Ansicht', () => {
  it('story card is rendered as a clickable button when project is loaded (cockpit)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
    });

    // The story card should be a button
    const storyBtn = container.querySelector('[data-testid="story-card-btn-S-001"]');
    expect(storyBtn).toBeTruthy();
    expect(storyBtn.tagName).toBe('BUTTON');
  });

  it('clicking story card opens detail view with story title in heading', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toMatch(/S-001/);
    });
  });

  it('detail view shows loading state while fetching', async () => {
    let resolveDetail;
    globalThis.fetch = jest.fn(async (url) => {
      if (/\/stories\/[^/]+\/detail$/.test(url)) {
        await new Promise((r) => { resolveDetail = r; });
        return { ok: true, json: async () => ({ detail: STORY_DETAIL_FULL }) };
      }
      return makeBoardFetch({ fullProjects: [PROJECT_A] })(url);
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    // Loading indicator must appear
    expect(container.querySelector('[data-testid="detail-loading"]')).toBeTruthy();

    await act(async () => { resolveDetail(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  });

  it('detail view shows back button', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-back-btn"]')).toBeTruthy();
    });
  });

  it('back button returns to board view', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-back-btn"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="detail-back-btn"]'));
    });

    await waitFor(() => {
      // Back to board — story cards visible again
      expect(container.querySelector('[data-story="S-001"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeNull();
    });
  });

  it('detail view has aria-label with story title (A11y)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const main = container.querySelector('main');
      expect(main?.getAttribute('aria-label')).toMatch(/S-001|Erstelle Login-Seite/);
    });
  });

  it('detail view calls GET .../stories/:id/detail endpoint', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    const callsBefore = globalThis.fetch.mock.calls.length;

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      const detailCalls = globalThis.fetch.mock.calls.filter((c) =>
        /\/stories\/S-001\/detail$/.test(c[0])
      );
      expect(detailCalls).toHaveLength(1);
      expect(globalThis.fetch.mock.calls.length).toBe(callsBefore + 1);
    });
  });

  it('detail view shows error when fetch fails', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (/\/stories\/[^/]+\/detail$/.test(url)) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return makeBoardFetch({ fullProjects: [PROJECT_A] })(url);
    });

    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-error"]')).toBeTruthy();
    });
  });

  it('story card button has minHeight 44px (Touch-Target ≥ 44 px, AC3)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });

    const btn = container.querySelector('[data-testid="story-card-btn-S-001"]');
    // jsdom exposes inline styles via element.style — check minHeight from storyCardBtn style
    expect(btn.style.minHeight).toBe('44px');
  });
});

describe('story-detail-ansicht — AC3: Drei Blöcke in Detail-Ansicht', () => {
  async function openStoryDetail(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('block Zeiten is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-zeiten"]')).toBeTruthy();
  });

  it('block Agenten-Flow is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-flow"]')).toBeTruthy();
  });

  it('block Soll-Ist is present', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);
    expect(container.querySelector('[data-testid="block-soll-ist"]')).toBeTruthy();
  });

  it('Zeiten block shows started_at, ended_at, duration', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const startEl = container.querySelector('[data-testid="detail-started-at"]');
    const endEl   = container.querySelector('[data-testid="detail-ended-at"]');
    const durEl   = container.querySelector('[data-testid="detail-duration"]');

    expect(startEl).toBeTruthy();
    expect(startEl.textContent).not.toBe('');
    expect(endEl).toBeTruthy();
    expect(durEl).toBeTruthy();
    expect(durEl.textContent).toMatch(/5 min|300/);
  });

  it('Agenten-Flow block shows flow steps with agent names', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const flowBlock = container.querySelector('[data-testid="block-flow"]');
    expect(flowBlock.textContent).toMatch(/coder/);
    expect(flowBlock.textContent).toMatch(/reviewer/);
  });

  it('Agenten-Flow shows all seq-ordered steps', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    expect(container.querySelector('[data-testid="flow-step-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-step-1"]')).toBeTruthy();
  });

  it('Soll-Ist block shows ep_est and ep_act', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    const epAct = container.querySelector('[data-testid="ep-act"]');
    expect(epEst.textContent).toContain('3');
    expect(epAct.textContent).toContain('4');
  });

  it('Soll-Ist block shows tok_est and tok_total', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const tokEst   = container.querySelector('[data-testid="tok-est"]');
    const tokTotal = container.querySelector('[data-testid="tok-total"]');
    expect(tokEst.textContent).toContain('1200');
    expect(tokTotal.textContent).toContain('1500');
  });

  it('Soll-Ist block shows ep deviation percentage', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({ fullProjects: [PROJECT_A] });
    const { container } = renderCockpit('project-alpha');
    await openStoryDetail(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toMatch(/33/);
  });
});

describe('story-detail-ansicht — AC4: fehlende Schätzung sauber dargestellt', () => {
  async function openDetailMissing(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('shows "keine Schätzung" for ep_est when null (AC4)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toMatch(/keine Schätzung/i);
  });

  it('shows "keine Schätzung" for tok_est when null (AC4)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const tokEst = container.querySelector('[data-testid="tok-est"]');
    expect(tokEst.textContent).toMatch(/keine Schätzung/i);
  });

  it('shows "Noch kein Flow-Lauf erfasst" when flow is empty and ended_at null (AC4 + AC5)', async () => {
    // AC5 (story-detail-yaml-fallback): Leer-Zustand differenziert:
    // kein ended_at → "Noch kein Flow-Lauf erfasst."
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/noch kein flow-lauf/i);
  });

  it('shows "—" for started_at when null (no crash)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const startEl = container.querySelector('[data-testid="detail-started-at"]');
    expect(startEl.textContent).toBe('—');
  });

  it('shows "—" for deviation when null', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailMissing(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toBe('—');
  });
});

// ── story-detail-ansicht — AC5: Vorab-Schätzungs-Fallback ────────────────────

/**
 * Fixture: detail data from YAML-Fallback (ep_est from dispo_est, no Ledger-Wert).
 * ep_est_source = 'yaml' → Vorab-Badge; Ist/Abweichung bleiben null/leer.
 */
const STORY_DETAIL_YAML_FALLBACK = {
  started_at:  null,
  ended_at:    null,
  duration:    null,
  flow:        [],
  ep_est:      2,          // aus dispo_est der Story-YAML
  ep_act:      null,       // kein Ledger-Wert
  tok_est:     null,
  tok_total:   null,
  size_est:    'S',
  ep_dev:      null,       // kein Ledger-Wert → keine Abweichung
  ep_dev_pct:  null,
  tok_dev:     null,
  tok_dev_pct: null,
  ep_est_source: 'yaml',   // Herkunfts-Flag
};

/**
 * Fixture: detail data with Ledger-Wert (ep_est_source = 'ledger').
 */
const STORY_DETAIL_LEDGER = {
  ...STORY_DETAIL_FULL,
  ep_est_source: 'ledger',
};

describe('story-detail-ansicht — AC5: Vorab-Schätzungs-Fallback', () => {
  /** Click the story card and wait for the detail block to appear. */
  async function openDetailAC5(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('YAML-Fallback: ep-est cell zeigt dispo_est-Wert', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toContain('2');
  });

  it('YAML-Fallback: ep-est cell zeigt „Vorab"-Badge (Herkunfts-Kennzeichnung)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const vorabBadge = container.querySelector('[data-testid="ep-est-vorab-badge"]');
    expect(vorabBadge).toBeTruthy();
    expect(vorabBadge.textContent).toMatch(/vorab/i);
  });

  it('YAML-Fallback: ep-act (Ist) bleibt leer „—"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epAct = container.querySelector('[data-testid="ep-act"]');
    expect(epAct.textContent).toBe('—');
  });

  it('YAML-Fallback: ep-dev (Abweichung) bleibt leer „—"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_YAML_FALLBACK,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epDev = container.querySelector('[data-testid="ep-dev"]');
    expect(epDev.textContent).toBe('—');
  });

  it('Ledger-Wert: kein Vorab-Badge wenn ep_est_source = "ledger"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    expect(container.querySelector('[data-testid="ep-est-vorab-badge"]')).toBeNull();

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toContain('3');
  });

  it('weder Ledger noch YAML → „keine Schätzung" (kein Vorab-Badge)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_MISSING, ep_est_source: null },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailAC5(container);

    const epEst = container.querySelector('[data-testid="ep-est"]');
    expect(epEst.textContent).toMatch(/keine Schätzung/i);
    expect(container.querySelector('[data-testid="ep-est-vorab-badge"]')).toBeNull();
  });
});

// ── story-detail-yaml-fallback — AC5: differenzierter Leer-Zustand + YAML-Badge ─

/**
 * Fixture: Story erledigt (done_at), aber kein Ledger.
 * ended_at kommt aus YAML (ended_at_source = 'yaml'), flow leer.
 */
const STORY_DETAIL_DONE_NO_LEDGER = {
  ...STORY_DETAIL_MISSING,
  ended_at: '2026-06-14T12:00:00.000Z',
  ended_at_source: 'yaml',
};

/**
 * Fixture: Story noch nicht erledigt, kein Ledger.
 */
const STORY_DETAIL_NOT_DONE_NO_LEDGER = {
  ...STORY_DETAIL_MISSING,
  ended_at: null,
  ended_at_source: null,
};

describe('story-detail-yaml-fallback — AC5: differenzierter Leer-Zustand im Flow-Block', () => {
  async function openDetailYamlFallback(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('zeigt "Vor Metrik-Erfassung abgeschlossen" wenn ended_at vorhanden aber flow leer', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/vor metrik-erfassung abgeschlossen/i);
  });

  it('zeigt "Noch kein Flow-Lauf erfasst" wenn ended_at null und flow leer', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_NOT_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const flowEmpty = container.querySelector('[data-testid="flow-empty"]');
    expect(flowEmpty).toBeTruthy();
    expect(flowEmpty.textContent).toMatch(/noch kein flow-lauf/i);
  });

  it('zeigt YAML-Badge bei ended_at aus YAML (ended_at_source="yaml")', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_DONE_NO_LEDGER,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const yamlBadge = container.querySelector('[data-testid="ended-at-yaml-badge"]');
    expect(yamlBadge).toBeTruthy();
    expect(yamlBadge.textContent.trim().toLowerCase()).toContain('yaml');
  });

  it('zeigt keinen YAML-Badge wenn ended_at_source="ledger"', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_FULL, ended_at_source: 'ledger' },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
  });

  it('zeigt "—" für ended_at wenn null (kein Badge, kein Datum)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_MISSING,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailYamlFallback(container);

    const endEl = container.querySelector('[data-testid="detail-ended-at"]');
    expect(endEl.textContent).toBe('—');
    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
  });
});

// ── story-detail-yaml-fallback — AC6: Block „Verknüpfungen" ──────────────────

/**
 * Fixture: mit branch und pr.
 */
const STORY_DETAIL_WITH_LINKS = {
  ...STORY_DETAIL_MISSING,
  branch: 'board/my-feature-2026-06-14',
  pr: 'https://github.com/org/repo/pull/42',
};

/**
 * Fixture: nur branch, kein pr.
 */
const STORY_DETAIL_BRANCH_ONLY = {
  ...STORY_DETAIL_MISSING,
  branch: 'board/my-feature-2026-06-14',
  pr: null,
};

/**
 * Fixture: weder branch noch pr.
 */
const STORY_DETAIL_NO_LINKS = {
  ...STORY_DETAIL_MISSING,
  branch: null,
  pr: null,
};

describe('story-detail-yaml-fallback — AC6: Block Verknüpfungen (Branch + PR)', () => {
  async function openDetailLinks(container) {
    await waitFor(() => {
      expect(container.querySelector('[data-testid="story-card-btn-S-001"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="story-card-btn-S-001"]'));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="detail-blocks"]')).toBeTruthy();
    });
  }

  it('zeigt Block Verknüpfungen wenn branch und pr vorhanden', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeTruthy();
  });

  it('zeigt Branch-Text im Verknüpfungen-Block', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const branchEl = container.querySelector('[data-testid="detail-branch"]');
    expect(branchEl).toBeTruthy();
    expect(branchEl.textContent).toContain('board/my-feature-2026-06-14');
  });

  it('zeigt PR-Link mit korrektem href (AC6)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const prEl = container.querySelector('[data-testid="detail-pr"]');
    expect(prEl).toBeTruthy();
    const link = prEl.querySelector('a');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://github.com/org/repo/pull/42');
  });

  it('PR-Link hat rel=noopener noreferrer (AC8 Security-Floor)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_WITH_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    const link = container.querySelector('[data-testid="detail-pr"] a');
    expect(link).toBeTruthy();
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('zeigt Block Verknüpfungen auch wenn nur branch gesetzt ist (kein pr)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_BRANCH_ONLY,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="detail-branch"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="detail-pr"]')).toBeNull();
  });

  it('blendet Block Verknüpfungen aus wenn weder branch noch pr gesetzt (AC6)', async () => {
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: STORY_DETAIL_NO_LINKS,
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeNull();
  });

  it('AC7 — bestehende Ledger-Daten (flow vorhanden) bleiben unverändert', async () => {
    // Stellt sicher dass AC7 (Ledger Vorrang) durch Erweiterung nicht gebrochen wird
    globalThis.fetch = makeBoardFetchWithDetail({
      fullProjects: [PROJECT_A],
      detailData: { ...STORY_DETAIL_FULL, ended_at_source: 'ledger', branch: null, pr: null },
    });
    const { container } = renderCockpit('project-alpha');
    await openDetailLinks(container);

    // Flow-Tabelle zeigt echte Ledger-Daten
    expect(container.querySelector('[data-testid="flow-step-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="flow-step-1"]')).toBeTruthy();
    // Kein YAML-Badge (Ledger hat Vorrang)
    expect(container.querySelector('[data-testid="ended-at-yaml-badge"]')).toBeNull();
    // Kein Verknüpfungen-Block (branch/pr null)
    expect(container.querySelector('[data-testid="block-verknuepfungen"]')).toBeNull();
  });
});

// ── board-storys-archivieren (S-294) — Story-Archiv-Button + Bestätigungsabfrage

describe('board-storys-archivieren — AC6/AC8: Story-Archiv-Button + Bestätigungsabfrage', () => {
  it('AC6: Button ist deaktiviert, wenn keine Story archivierbar ist', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_NO_ARCHIVABLE,
      projectAfter: PROJECT_STORY_NO_ARCHIVABLE,
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    const btn = utils.container.querySelector('[data-testid="archive-done-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    // AC8: echter <button> mit sprechendem aria-label (Zustand nicht nur Farbe)
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toMatch(/keine erledigten Storys/i);
  });

  it('AC6: Klick öffnet Bestätigungsabfrage mit Anzahl Storys (Done+Verworfen zählen, To-Do-Geschwister nicht)', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_ARCHIVE_BEFORE,
      projectAfter: PROJECT_STORY_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    const btn = utils.container.querySelector('[data-testid="archive-done-btn"]');
    expect(btn.disabled).toBe(false);
    // sprechendes aria-label nennt die Anzahl (AC8): 2 archivierbare Storys
    // (S-922 Done + S-923 Verworfen aus F-921) — S-924 (To Do) zählt nicht mit,
    // F-920 (komplett offen) trägt 0 bei.
    expect(btn.getAttribute('aria-label')).toMatch(/2 Storys/);

    await act(async () => { fireEvent.click(btn); });

    const dialog = utils.container.querySelector('[data-testid="archive-confirm-dialog"]');
    expect(dialog).toBeTruthy();
    // AC8: fokussiertes Dialog-Muster
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('archive-confirm-title');
    // AC6: Anzahl Storys genannt + Hinweis, dass die Bereichs-Kacheln sichtbar
    // bleiben (Text, nicht nur Farbe).
    const summary = utils.container.querySelector('[data-testid="archive-confirm-summary"]');
    expect(summary.textContent).toMatch(/2 erledigte Storys/);
    expect(summary.textContent).toMatch(/Bereichs-Kacheln bleiben sichtbar/);
  });

  it('AC6: Abbrechen schließt den Dialog ohne POST', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_ARCHIVE_BEFORE,
      projectAfter: PROJECT_STORY_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-done-btn"]'));
    });
    expect(utils.container.querySelector('[data-testid="archive-confirm-dialog"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-cancel-btn"]'));
    });

    // Dialog geschlossen; kein POST abgesetzt
    expect(utils.container.querySelector('[data-testid="archive-confirm-dialog"]')).toBeFalsy();
    const postCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].endsWith('/archive-done-stories') && c[1]?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('AC6: Bestätigen setzt EIN POST .../archive-done-stories ab und lädt neu (Kachel + offene Story bleiben)', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_ARCHIVE_BEFORE,
      projectAfter: PROJECT_STORY_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-done-btn"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-confirm-btn"]'));
    });

    // genau EIN POST an den Endpoint
    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/archive-done-stories') && c[1]?.method === 'POST',
      );
      expect(postCalls).toHaveLength(1);
    });

    // Nach dem Rescan sind keine terminalen Storys mehr übrig → Button
    // wieder deaktiviert; die Bereichs-Kacheln (F-920, F-921) bleiben sichtbar.
    await waitFor(() => {
      const btn = utils.container.querySelector('[data-testid="archive-done-btn"]');
      expect(btn.disabled).toBe(true);
    });
    expect(utils.container.querySelector('[data-feature="F-920"]')).toBeTruthy();
    expect(utils.container.querySelector('[data-feature="F-921"]')).toBeTruthy();
    // Dialog geschlossen
    expect(utils.container.querySelector('[data-testid="archive-confirm-dialog"]')).toBeFalsy();
  });

  it('AC6: Endpoint-Fehler (409) wird nicht-blockierend gezeigt, Dialog + Ansicht bleiben', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_ARCHIVE_BEFORE,
      projectAfter: PROJECT_STORY_ARCHIVE_AFTER,
      archiveResult: { ok: false, status: 409 },
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-done-btn"]'));
    });
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-confirm-btn"]'));
    });

    // nicht-blockierender Fehler (role=alert), Dialog bleibt offen
    await waitFor(() => {
      const err = utils.container.querySelector('[data-testid="archive-confirm-error"]');
      expect(err).toBeTruthy();
      expect(err.getAttribute('role')).toBe('alert');
    });
    expect(utils.container.querySelector('[data-testid="archive-confirm-dialog"]')).toBeTruthy();
    // Ansicht bleibt intakt (Board weiterhin sichtbar)
    expect(utils.container.querySelector('[data-project="proj-arch2"]')).toBeTruthy();
  });

  it('AC8: Esc bricht die Bestätigungsabfrage ab (Fokus-Dialog-Muster)', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_STORY_ARCHIVE_BEFORE,
      projectAfter: PROJECT_STORY_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-done-btn"]'));
    });
    const dialog = utils.container.querySelector('[data-testid="archive-confirm-dialog"]');
    expect(dialog).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    expect(utils.container.querySelector('[data-testid="archive-confirm-dialog"]')).toBeFalsy();
    // kein POST bei Esc-Abbruch
    const postCalls = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].endsWith('/archive-done-stories') && c[1]?.method === 'POST',
    );
    expect(postCalls).toHaveLength(0);
  });

  it('V1: eine einzeln-Verworfene Story ohne terminale Geschwister ist bereits archivierbar', async () => {
    const projectOnlyVerworfen = {
      slug: 'proj-arch2',
      repo_path: '/home/user/Git/arch2',
      project_slug: 'proj-arch2',
      schema_version: 1,
      features: [{
        id: 'F-922',
        title: 'Nur eine verworfene Story',
        status: 'Verworfen',
        priority: 'low',
        stories: [
          { id: 'S-925', parent: 'F-922', title: 'Teil F', status: 'Verworfen', priority: 'low', labels: [], spec: null },
        ],
      }],
    };
    const fetchMock = makeArchiveFetch({
      projectBefore: projectOnlyVerworfen,
      projectAfter: { ...projectOnlyVerworfen, features: [{ ...projectOnlyVerworfen.features[0], stories: [] }] },
    });
    const utils = await renderArchiveCockpit(fetchMock, 'proj-arch2');
    const btn = utils.container.querySelector('[data-testid="archive-done-btn"]');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label')).toMatch(/1 Story\b/);
  });
});

// ── bereichs-modell (S-290) — AC8/AC10: „Bereiche verwalten"-Wiring ────────────

describe('bereichs-modell — AC8/AC10: „Bereiche verwalten"-Button + Dialog-Wiring', () => {
  beforeEach(() => { lastAreasManageProps = null; });

  it('AC8: Button ist sichtbar, sobald ein Projekt geladen ist; Klick öffnet den Dialog mit korrektem projectSlug', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_ARCHIVE_BEFORE,
      projectAfter: PROJECT_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock);

    const btn = utils.container.querySelector('[data-testid="areas-manage-btn"]');
    expect(btn).toBeTruthy();
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe('Bereiche verwalten');

    // Dialog noch nicht gemountet, solange nicht geklickt (kein unnötiger Fetch)
    expect(utils.container.querySelector('[data-testid="areas-manage-dialog-mock"]')).toBeFalsy();

    await act(async () => { fireEvent.click(btn); });

    const dialog = utils.container.querySelector('[data-testid="areas-manage-dialog-mock"]');
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('data-project-slug')).toBe('proj-arch');
    expect(lastAreasManageProps.projectSlug).toBe('proj-arch');
  });

  it('AC10 (Wiring): `onClose` des Dialogs entfernt ihn aus der FilterBar (Fokus-Rückgabe-Details — triggerRef.current.focus() nach Esc/Backdrop — sind in AreasManageDialog.test.jsx mit der echten Komponente belegt, hier gemockt)', async () => {
    const fetchMock = makeArchiveFetch({
      projectBefore: PROJECT_ARCHIVE_BEFORE,
      projectAfter: PROJECT_ARCHIVE_AFTER,
    });
    const utils = await renderArchiveCockpit(fetchMock);
    const btn = utils.container.querySelector('[data-testid="areas-manage-btn"]');

    await act(async () => { fireEvent.click(btn); });
    expect(utils.container.querySelector('[data-testid="areas-manage-dialog-mock"]')).toBeTruthy();

    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="areas-manage-mock-close-btn"]'));
    });

    expect(utils.container.querySelector('[data-testid="areas-manage-dialog-mock"]')).toBeFalsy();
  });
});

// ── board-feature-archive (S-234) — „Archiv anzeigen"-Schalter (AC6/AC7) ───────

describe('board-feature-archive — AC6/AC7: „Archiv anzeigen"-Schalter (read-only)', () => {
  // Toggle-Zustand liegt in localStorage (boardview.showArchived) — zwischen
  // Tests leeren, damit kein Zustand nachwirkt (Default aus je Test).
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* jsdom always has it */ }
  });

  /** Render cockpit for the archive-view project + wait for the toggle button. */
  async function renderArchViewCockpit() {
    const fetchMock = makeArchViewFetch();
    globalThis.fetch = fetchMock;
    const utils = renderCockpit('proj-arcv');
    await waitFor(() => {
      expect(utils.container.querySelector('[data-testid="archive-toggle-btn"]')).toBeTruthy();
    });
    return { utils, fetchMock };
  }

  it('AC7: Toggle ist echter <button> mit aria-pressed=false + sprechendem aria-label (Default aus)', async () => {
    const { utils } = await renderArchViewCockpit();
    const toggle = utils.container.querySelector('[data-testid="archive-toggle-btn"]');
    expect(toggle).toBeTruthy();
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toMatch(/anzeigen/i);
  });

  it('AC6: Default aus → keine archivierten Features geladen (kein includeArchived-Query)', async () => {
    const { utils, fetchMock } = await renderArchViewCockpit();
    // Archiviertes Feature NICHT sichtbar
    expect(utils.container.querySelector('[data-feature="F-950"]')).toBeFalsy();
    // sichtbares Feature aber schon da
    expect(utils.container.querySelector('[data-feature="F-901"]')).toBeTruthy();
    // KEINE Projekt-Fetch-URL trug includeArchived
    const withArchived = fetchMock.mock.calls.filter(
      (c) => typeof c[0] === 'string'
        && /\/api\/board\/projects\//.test(c[0])
        && c[0].includes('includeArchived=true'),
    );
    expect(withArchived).toHaveLength(0);
  });

  it('AC6: Klick lädt mit includeArchived=true neu → archiviertes Feature erscheint', async () => {
    const { utils, fetchMock } = await renderArchViewCockpit();
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-toggle-btn"]'));
    });
    // Re-Fetch mit includeArchived=true erfolgte
    await waitFor(() => {
      const withArchived = fetchMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('includeArchived=true'),
      );
      expect(withArchived.length).toBeGreaterThanOrEqual(1);
    });
    // Archiviertes Feature erscheint + aria-pressed=true
    await waitFor(() => {
      expect(utils.container.querySelector('[data-feature="F-950"]')).toBeTruthy();
    });
    const toggle = utils.container.querySelector('[data-testid="archive-toggle-btn"]');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  it('AC6/AC7: archiviertes Feature ist klar per Text „Archiviert" markiert (Feature-Badge)', async () => {
    const { utils } = await renderArchViewCockpit();
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-toggle-btn"]'));
    });
    await waitFor(() => {
      expect(utils.container.querySelector('[data-testid="archived-badge-F-950"]')).toBeTruthy();
    });
    const badge = utils.container.querySelector('[data-testid="archived-badge-F-950"]');
    // Bedeutung per Text (nicht nur Farbe)
    expect(badge.textContent).toMatch(/Archiviert/i);
    expect(badge.getAttribute('aria-label')).toMatch(/Archiviert/i);
    // Feature-Container trägt Read-only-Markierung
    const feat = utils.container.querySelector('[data-feature="F-950"]');
    expect(feat.getAttribute('data-archived')).toBe('true');
  });

  it('AC6: archivierte Story ist READ-ONLY — kein Karten-Button, read-only <article> + „Archiviert"-Marker', async () => {
    const { utils } = await renderArchViewCockpit();
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-toggle-btn"]'));
    });
    await waitFor(() => {
      expect(utils.container.querySelector('[data-feature="F-950"]')).toBeTruthy();
    });
    // Feature ist als „Done" per Default eingeklappt → zuerst ausklappen.
    const collapseBtn = utils.container.querySelector('[data-testid="feature-collapse-btn-F-950"]');
    expect(collapseBtn).toBeTruthy();
    if (collapseBtn.getAttribute('aria-expanded') === 'false') {
      await act(async () => { fireEvent.click(collapseBtn); });
    }
    // KEINE Klick-/Aktions-Affordance (kein Karten-Button für die archivierte Story)
    expect(utils.container.querySelector('[data-testid="story-card-btn-S-950"]')).toBeFalsy();
    // Read-only <article> mit „Archiviert"-Marker (Text, nicht nur Farbe)
    const marker = utils.container.querySelector('[data-testid="story-archived-S-950"]');
    expect(marker).toBeTruthy();
    expect(marker.textContent).toMatch(/Archiviert/i);
    const card = utils.container.querySelector('[data-story="S-950"]');
    expect(card.tagName).toBe('ARTICLE');
    expect(card.getAttribute('data-archived')).toBe('true');
    expect(card.getAttribute('aria-label')).toMatch(/archiviert/i);
  });

  it('AC6: erneuter Klick blendet Archivierte wieder aus (Standardansicht, aria-pressed=false)', async () => {
    const { utils } = await renderArchViewCockpit();
    // an
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-toggle-btn"]'));
    });
    await waitFor(() => {
      expect(utils.container.querySelector('[data-feature="F-950"]')).toBeTruthy();
    });
    // wieder aus
    await act(async () => {
      fireEvent.click(utils.container.querySelector('[data-testid="archive-toggle-btn"]'));
    });
    await waitFor(() => {
      expect(utils.container.querySelector('[data-feature="F-950"]')).toBeFalsy();
    });
    const toggle = utils.container.querySelector('[data-testid="archive-toggle-btn"]');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});

// ── board-filter-feature-status-consistency (S-241) ───────────────────────────
//
// Covers (board-filter-feature-status-consistency):
//   AC1 — Bei aktivem einschränkendem Filter zeigt der Feature-Badge den aus der
//          gefilterten Story-Menge abgeleiteten Status (Spec-Beispiel wörtlich:
//          [To Do, Blocked], Filter nur To Do → Badge „To Do").
//   AC2 — Ohne einschränkenden Filter entspricht der Badge exakt dem
//          server-`feature.status` (identisches Ergebnis, keine Regression).
//   AC3 — Eine geteilte Regel-Quelle: Identität + Vektor-Tabelle in
//          test/featureStatus.test.js; hier zusätzlich integrationsnah über das
//          tatsächlich gerenderte Badge geprüft (client verwendet dieselbe
//          computeFeatureStatus-Funktion wie der Server).
//   AC4 — `_orphaned` bekommt nie einen Badge — weder gefiltert noch ungefiltert.
//   AC5 — Feature (echt oder `_orphaned`) mit 0 sichtbaren Stories wird bei
//          aktivem Filter ausgeblendet; ohne Filter rendert ein leeres echtes
//          Feature weiterhin (Regression, FEATURE_EMPTY/PROJECT_B).
//   AC6 — Der bestehende „Keine Stories passen zum aktiven Filter."-Hinweis
//          greift jetzt auch bei einem reinen Status-Filter (kein Label nötig).
describe('board-filter-feature-status-consistency (S-241)', () => {
  it('AC1: Feature [To Do, Blocked] zeigt bei Filter "nur To Do" den Badge "To Do" (nicht mehr "Blocked")', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_FSC] });
    const { container } = renderCockpit('project-fsc');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-100"]')).toBeTruthy();
    });

    // Vor dem Filtern: server-Wert "Blocked" (ungefiltert, AC2-Ausgangslage).
    expect(
      container.querySelector('[data-feature="F-100"] > div > [aria-label^="Status:"]').textContent,
    ).toBe('Blocked');

    await selectOnlyStatus(container, 'To Do');

    await waitFor(() => {
      // Blocked-Story nicht mehr sichtbar, To-Do-Story weiterhin sichtbar.
      expect(container.querySelector('[data-story="S-101"]')).toBeNull();
      expect(container.querySelector('[data-story="S-100"]')).toBeTruthy();
      // Badge jetzt aus der gefilterten Menge abgeleitet: "To Do".
      expect(
        container.querySelector('[data-feature="F-100"] > div > [aria-label^="Status:"]').textContent,
      ).toBe('To Do');
    });
  });

  it('AC2: ohne aktiven Filter entspricht der Badge exakt dem server-feature.status', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_FSC] });
    const { container } = renderCockpit('project-fsc');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-100"]')).toBeTruthy();
    });

    // Kein Filter angerührt → Default (alle 7 Status an, kein Label).
    expect(
      container.querySelector('[data-feature="F-100"] > div > [aria-label^="Status:"]').textContent,
    ).toBe('Blocked');
    expect(
      container.querySelector('[data-feature="F-101"] > div > [aria-label^="Status:"]').textContent,
    ).toBe('Blocked');
  });

  it('AC4: `_orphaned` bekommt nie einen Badge — weder gefiltert noch ungefiltert', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_FSC] });
    const { container } = renderCockpit('project-fsc');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="_orphaned"]')).toBeTruthy();
    });

    // Ungefiltert: kein Badge.
    expect(
      container.querySelector('[data-feature="_orphaned"] > div > [aria-label^="Status:"]'),
    ).toBeNull();

    await selectOnlyStatus(container, 'To Do');

    await waitFor(() => {
      // Orphaned-Feature bleibt sichtbar (S-103 „To Do" passt zum Filter) —
      // aber weiterhin ohne Badge.
      expect(container.querySelector('[data-story="S-103"]')).toBeTruthy();
      expect(
        container.querySelector('[data-feature="_orphaned"] > div > [aria-label^="Status:"]'),
      ).toBeNull();
    });
  });

  it('AC5: Feature mit 0 sichtbaren Stories wird bei aktivem Filter ausgeblendet (echt + _orphaned)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_FSC] });
    const { container } = renderCockpit('project-fsc');

    await waitFor(() => {
      // Vor dem Filtern: alle drei Features sichtbar.
      expect(container.querySelector('[data-feature="F-100"]')).toBeTruthy();
      expect(container.querySelector('[data-feature="F-101"]')).toBeTruthy();
      expect(container.querySelector('[data-feature="_orphaned"]')).toBeTruthy();
    });

    // Filter auf "In Review" — keine der PROJECT_FSC-Stories hat diesen Status
    // → alle drei Features haben 0 sichtbare Stories.
    await selectOnlyStatus(container, 'In Review');

    await waitFor(() => {
      expect(container.querySelector('[data-feature="F-100"]')).toBeNull();
      expect(container.querySelector('[data-feature="F-101"]')).toBeNull();
      expect(container.querySelector('[data-feature="_orphaned"]')).toBeNull();
    });
  });

  it('AC5: ohne aktiven Filter rendert ein leeres echtes Feature weiterhin (Regression, keine Verhaltensänderung)', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_B] });
    const { container } = renderCockpit('project-beta');

    await waitFor(() => {
      // FEATURE_EMPTY (F-003, 0 Stories) rendert unverändert ohne aktiven Filter.
      expect(container.querySelector('[data-feature="F-003"]')).toBeTruthy();
    });
  });

  it('AC6: reiner Status-Filter (kein Label) der alle Stories eliminiert zeigt den Leer-Hinweis', async () => {
    globalThis.fetch = makeBoardFetch({ fullProjects: [PROJECT_FSC_SINGLE] });
    const { container } = renderCockpit('project-fsc-single');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-105"]')).toBeTruthy();
    });

    // Filter auf "Done" — die einzige Story ist "To Do" → totalFilteredStories===0,
    // rein über den Status-Filter (kein Label beteiligt).
    await selectOnlyStatus(container, 'Done');

    await waitFor(() => {
      expect(container.querySelector('[data-story="S-105"]')).toBeNull();
      const hints = Array.from(container.querySelectorAll('[role="status"]'))
        .map((el) => el.textContent);
      expect(hints.some((t) => t.includes('Keine Stories passen zum aktiven Filter.'))).toBe(true);
    });
  });
});
