/**
 * BoardView.jsx — Studis-Kanban-Board: Projekt → Feature → Story.
 *
 * dev-gui-board-aggregator:
 *   AC4  — Dreistufige Übersicht Projekt → Feature → Story mit Status-Spalten
 *           (Idee / To Do / In Progress / Blocked / In Review / Done), aggregiert über
 *           alle gescannten Projekte. Lädt GET /api/board/projects beim Mount.
 *           Ladezustand (aria-busy/aria-live); Fehlerzustand; Leerzustand.
 *   AC5  — Rollup-Anzeige je Feature: vorhandenes progress-Feld nutzen; fehlt/stale
 *           → read-only aus Kind-Story-Status berechnet (done = 'done'-Stories).
 *   AC6  — Filter nach Projekt, Story-Status und Label (alle unabhängig kombinierbar).
 *          Status-Filter: Mehrfachauswahl per Checkbox-Gruppe (leere Auswahl = alle sichtbar).
 *
 * studis-kanban-board-ux:
 *   AC1  — Umbenennung: View-Titel + aria-label = „Studis-Kanban-Board". Route-id bleibt `board`.
 *   AC2  — Status-Filter-Default: alle Status vorausgewählt (alles sichtbar);
 *           Deselektieren blendet aus. (Seit board-status-verworfen AC3: 7 Status
 *           inkl. „Idee" und „Verworfen".)
 *   AC3  — Alle Status deselektiert → keine Stories + role=status „Kein Status gewählt".
 *   AC4  — Status-Filter als Popover: Button „Status (n/N) ▾", Klick-Toggle,
 *           schließt bei Außenklick + Esc; aria-expanded/-controls.
 *   AC5  — GET /api/board/projects/list (leicht) + GET /api/board/projects/:slug (voll).
 *   AC6  — Standalone: öffnet mit Projektliste, Klick lädt ein Projekt (lazy).
 *           Cockpit-Modus (lockedProject): direktes Anzeigen, keine Liste.
 *   AC7  — „Alle/Keine"-Toggle im Status-Popover, oberhalb der Checkboxen, optisch
 *           leicht nach links versetzt: alle ausgewählt → alle abwählen (greift AC3),
 *           sonst → alle auswählen. aria-pressed + aria-label (Aktion), tastaturbedienbar.
 *
 * team-entity-icons:
 *   AC12 — StoryCard zeigt ein <EntityIcon> (size=14) vor story.id wenn
 *           story.labels ein Label der Form „<kind>:<id>" enthält
 *           (kind ∈ agent|skill|knowledge). Label-Parsing via
 *           parseEntityLabel(); kein neues Datenfeld, kein neuer API-Aufruf.
 *
 * story-detail-ansicht:
 *   AC3  — Klick auf Story-Karte öffnet Detail-Ansicht mit drei Blöcken:
 *           (1) Zeiten (Start/Ende/Dauer), (2) Agenten-Flow (chronologisch,
 *           je Schritt Agent/Iteration/Gate/Dauer), (3) Soll-Ist
 *           (ep_est↔ep_act, tok geschätzt↔tatsächlich, Abweichung %).
 *           Rückweg zum Board. Touch-Targets ≥ 44 px.
 *   AC4  — Soll-Ist zeigt ep_est↔ep_act + tok_est↔tok_total mit Abweichung %;
 *           fehlende Schätzung sauber dargestellt als „keine Schätzung".
 *   AC5  — Vorab-Schätzungs-Fallback: wenn items.jsonl kein ep_est liefert, zeigt
 *           die Soll-Ist-Ansicht dispo_est aus der Story-YAML mit einem „Vorab"-Badge.
 *           Ist-/Abweichungs-Spalten bleiben leer bis zum Flow-Lauf.
 *           ep_est_source: 'yaml' → Vorab-Badge; 'ledger' → kein Badge; null → keine Schätzung.
 *
 * story-detail-yaml-fallback:
 *   AC5  — Differenzierter Leer-Zustand im Agenten-Flow-Block: „Vor Metrik-Erfassung
 *           abgeschlossen" (done_at vorhanden) vs. „Noch kein Flow-Lauf erfasst".
 *           Ende-Zeit zeigt auch YAML-Quelle (ended_at_source='yaml') mit YAML-Badge.
 *   AC6  — Block „Verknüpfungen" mit Branch (Text) + PR (externer Link, noopener noreferrer);
 *           Block ausgeblendet wenn weder branch noch pr vorhanden.
 *   AC7  — Ledger hat Vorrang: bestehende Ledger-Daten unverändert.
 *   AC8  — Kein dangerouslySetInnerHTML; externer PR-Link mit rel=noopener noreferrer.
 *
 * autonome-board-abarbeitung:
 *   AC4  — Board zeigt Ready-/Blocked-Status: Ready-To-Do-Stories tragen ein dezentes
 *           „ready"-Badge (grün); Blocked-Stories zeigen ihren blocked_reason als
 *           Hinweiszeile unter dem Titel. Kontrast WCAG AA; aria-label an Badges.
 *
 * ideen-inbox:
 *   AC1  — Status „Idee" ist erstes Element von STATUS_LIFECYCLE (ganz links vor
 *           „To Do"); „Idee"-Spalte rendert links von „To Do"; Status-Filter führt
 *           „Idee" (Default ausgewählt, wie alle Status).
 *   AC2  — Idee-Items sind nie ready: computeStoryReadyStatus (src/BoardAggregator.js)
 *           liefert für status ≠ To Do bereits ready=false/ready_reason=null; die
 *           Ready-Badge-Bedingung bleibt auf story.status === 'To Do' beschränkt →
 *           „Idee"-Karten zeigen kein ready-Badge (kein neuer Code nötig, nur Test-Beleg).
 *   AC5/AC6 — SUPERSEDED durch idea-specify-chat (S-218, siehe unten): der frühere
 *           discuss-Tab-Sprung (POST .../discuss, onDiscussIdea, PTY-Terminal-Wechsel)
 *           und die frühere Resolve-UI (IdeaResolveModal, POST .../resolve) sind
 *           vollständig entfernt und durch das Chat-Overlay (IdeaSpecifyChatModal)
 *           ersetzt.
 *
 * idea-specify-chat:
 *   AC1  — Klick auf eine Idee-Karte (status === 'Idee') ODER auf den Button
 *           „Spezifizieren" öffnet dasselbe Chat-Overlay (`IdeaSpecifyChatModal`)
 *           über dem Board — kein Tab-Wechsel, kein Detail-Fetch. Beide Auslöser
 *           rufen `handleOpenSpecifyChat(slug, story, triggerEl)` auf, die den
 *           `specifyingIdea`-State ({slug, story}) setzt; das Modal rendert, wenn
 *           `specifyingIdea` gesetzt ist. A11y/Bubble-Verhalten lebt in
 *           `IdeaSpecifyChatModal.jsx` (S-217).
 *   AC2  — Button-Umbenennung: `StoryCard` zeigt statt „Idee auflösen" den Button
 *           „Spezifizieren" (Prop `onResolveIdea` → `onSpecifyIdea`, gleiche
 *           Aufrufsignatur `(story, triggerEl)`); der alte reine Verwerfen-Pfad
 *           (IdeaResolveModal) sowie der discuss-Tab-Sprung (onDiscussIdea,
 *           handleIdeaDiscuss) sind entfernt. `onSpecified(projectSlug)` löst ein
 *           Re-Fetch der Board-Daten aus (Wiederverwendung des bestehenden
 *           Cockpit-/Standalone-Lade-Mechanismus über `reloadToken`).
 *
 * idea-specify-background-status (S-230):
 *   AC3  — Lauf-Indikator auf der Idee-Karte: solange ein Finalize-Job für die
 *           Idee `running` ist, rendert `StoryCard` ein sichtbares Badge
 *           „wird spezifiziert…" (Text + ⟳-Icon + aria-busy/role=status/aria-live),
 *           nicht nur farblich. Job-Status kommt aus `specifyJobs` (Map ideaId→Job),
 *           durchgereicht ProjectSection→FeatureRow→StatusColumn→StoryCard.
 *   AC4  — Bei failed/auth-expired zeigt die Karte einen nicht-blockierenden,
 *           secret-freien Fehler-Hinweis („Spezifizieren fehlgeschlagen — erneut
 *           versuchen"); die Karte bleibt anklickbar (Retry via Overlay-Reopen).
 *           Bei `done` liefert der Endpunkt keinen Job → kein Badge.
 *   AC5  — Hydratisieren + Polling + Re-Fetch: `fetchSpecifyJobs` liest
 *           GET …/specify/jobs beim Board-Load und nach Overlay-Schließen
 *           (specifyCloseToken). Gepollt wird NUR solange ≥1 running-Job existiert
 *           (setInterval, sonst kein Poll — Ruhezustand). Verschwindet ein zuvor
 *           running-Job (→ done) → GENAU EIN Board-Re-Fetch über handleSpecified
 *           (reloadToken/handleProjectSelect). Reload-fest (Server-Registry).
 *
 * story-specify-finalize-visibility (S-240):
 *   AC6  — Nicht-blockierender Board-Hinweis: trägt der letzte PROJEKT-keyed
 *           Finalize-Lauf des aktuellen Projekts `no-op`/`failed`/`auth-expired`
 *           (GET .../story-specify/finalize), zeigt das Board einen nicht-
 *           blockierenden, secret-freien Hinweis („Story-Erstellung fehlgeschlagen
 *           — erneut versuchen") mit Text + ⚠-Icon (nicht nur Farbe;
 *           role=status/aria-live), der die Board-Nutzung nicht blockiert und
 *           quittierbar ist (✕) bzw. verschwindet, sobald ein neuer Lauf
 *           running/done erreicht. `fetchFinalizeJob` hydratisiert beim Board-Load
 *           (reload-fest über die Server-Registry, S-239) und pollt NUR, solange
 *           der letzte Job `running` ist (kein Dauer-Poll im Ruhezustand).
 *
 * board-feature-collapse:
 *   AC1  — Jede Feature-Zeile hat einen Auf-/Zu-Schalter (Collapse-Button mit Chevron);
 *           eingeklappt sind Story-Spalten ausgeblendet; ausgeklappt wie bisher sichtbar.
 *   AC2  — Ziel/DoD-Detail-Panel auf separaten Schalter entkoppelt; bei eingeklapptem
 *           Feature ist der Detail-Schalter ausgeblendet.
 *   AC3  — Default „Gemischt": erledigte Features (done==total, total>0, oder status
 *           Done/Archived) eingeklappt; übrige ausgeklappt.
 *   AC4  — „Alle einklappen" / „Alle ausklappen" in der Board-Kopfleiste.
 *   AC5  — Zustand pro Projekt im localStorage (Key boardview.collapsed.<slug>);
 *           defektes/fehlendes localStorage → stiller Default, kein Crash.
 *   AC6  — Bei aktivem einschränkendem Filter: eingeklappte Features mit passenden
 *           Stories temporär ausgeklappt dargestellt; gespeicherter Zustand nicht
 *           überschrieben.
 *   AC7  — A11y: Auf-/Zu-Schalter sind button mit aria-expanded + aria-controls;
 *           Tastatur (Enter/Space); Fokusring erhalten; Chevron aria-hidden.
 *   AC8  — Kein dangerouslySetInnerHTML; kein neuer API-Aufruf; keine Secrets.
 *
 * board-feature-archive:
 *   > **⟶ Superseded für den Archiv-Knopf + Endpoint ([[board-storys-archivieren]],
 *   > S-294):** der Knopf heißt jetzt „Erledigte Storys archivieren" und ruft
 *   > `POST …/archive-done-stories` auf (Archivierbarkeit pro STORY, nicht mehr
 *   > pro Feature — siehe unten). Die Feature-Ebenen-Variante (`archive-done`)
 *   > bleibt Backend-seitig für Altbestände erhalten, hat aber keinen Frontend-
 *   > Trigger mehr.
 *   AC5/AC7 (S-233) — SUPERSEDED, siehe oben.
 *   AC6/AC7 (S-234) — „Archiv anzeigen"-Schalter (Default aus, echter Toggle-
 *           Button mit aria-pressed) in der FilterBar. Ist er an, laden die
 *           Board-Fetches mit `?includeArchived=true` (V3) neu; archivierte
 *           Features/Stories erscheinen READ-ONLY (keine Klick-/Aktions-
 *           Affordance: kein Karten-Button, kein Spezifizieren) und klar per
 *           Text „Archiviert" markiert (nicht nur farblich). Toggle-Zustand
 *           lokal in localStorage (`boardview.showArchived`); defektes
 *           localStorage → stiller Default (aus), kein Crash. Bleibt UNVERÄNDERT
 *           in Kraft (board-storys-archivieren AC7 wiederverwendet dieselbe
 *           Implementierung 1:1).
 *
 * board-storys-archivieren (S-294):
 *   AC6 — Knopf „Erledigte Storys archivieren" (FilterBar): deaktiviert, wenn
 *           keine Story archivierbar ist (V1: status ∈ {Done, Verworfen} UND
 *           nicht bereits `archived` — pro STORY berechnet, unabhängig vom
 *           Geschwister-Status im selben Feature); sonst öffnet ein Klick eine
 *           Bestätigungsabfrage (`ArchiveConfirmDialog`) mit der Anzahl
 *           betroffener Storys + Hinweis, dass die Bereichs-Kacheln sichtbar
 *           bleiben. Abbrechen ändert nichts. Bestätigen setzt
 *           `POST …/archive-done-stories` ab und lädt die Übersicht neu
 *           (archivierte Storys verschwinden, Kacheln bleiben). Endpoint-Fehler
 *           (409/5xx) erscheinen nicht-blockierend (role=alert) im Dialog.
 *   AC7 — „Archiv anzeigen"-Schalter unverändert wiederverwendet (siehe
 *           board-feature-archive AC6/AC7 oben) — zeigt archivierte Storys
 *           read-only + klar markiert.
 *   AC8 — A11y: Knopf + Schalter sind echte `button`-Elemente mit sprechendem
 *           `aria-label`; Bestätigungsabfrage bleibt das fokussierte
 *           Dialog-Muster (role="dialog", Fokusfalle/Esc, sichtbarer
 *           Fokusring); Bedeutung nicht allein über Farbe (Text).
 *
 * board-status-verworfen (S-242):
 *   AC1  — „Verworfen" ist das 7. (letzte) Element von STATUS_LIFECYCLE, rendert
 *           als 7. Kanban-Spalte rechts neben „Done"; Spalte immer gerendert
 *           (auch bei 0 Stories in ihr), Grid folgt STATUS_LIFECYCLE.length.
 *   AC2  — STATUS_BADGE_STYLES['Verworfen'] trägt einen eigenen, gedämpft-
 *           neutralen Grauton, klar vom grünen „Done"-Ton abgesetzt; Bedeutung
 *           via sichtbaren Text „Verworfen" (nicht nur Farbe), Kontrast AA.
 *   AC3  — „Verworfen" ist 7. Filter-Checkbox, beim Öffnen vorausgewählt
 *           (Default alle an, wie alle STATUS_LIFECYCLE-Werte); n/N-Zähler
 *           zählt bis 7; „Alle/Keine"-Toggle bezieht „Verworfen" automatisch
 *           ein — keine Status-spezifische Sonderlogik.
 *   AC4  — Eine Story mit status „Verworfen" landet in der Verworfen-Spalte
 *           (byStatus['Verworfen']), NICHT im To-Do-Fallback-Bucket; der
 *           Fallback bleibt für echte unbekannte Status erhalten.
 *   AC5  — Regressions-Invariante (kein Code-Delta in src/ erwartet): dev-gui
 *           hat keinen Verworfen-Schreibpfad; ProjectDrain (nur To Do/In
 *           Progress lebendig) + Ready-Berechnung (status === 'To Do') greifen
 *           Verworfen-Stories nicht auf — Test lebt in test/ProjectDrain.test.js
 *           + test/boardReadyStatus.test.js, nicht in dieser Datei.
 *
 * board-filter-feature-status-consistency (S-241):
 *   AC1  — Bei aktivem einschränkendem Filter (hasRestrictingFilter) wird der
 *           angezeigte Feature-Status-Badge aus der GEFILTERTEN Story-Menge
 *           abgeleitet (computeFeatureStatus aus ../../src/featureStatus.js,
 *           EINE geteilte Regel-Quelle mit src/BoardAggregator.js — Cross-Build-
 *           Import via Vite verifiziert, siehe AC3) statt aus dem server-
 *           berechneten feature.status.
 *   AC2  — Ohne aktiven Filter ist die sichtbare Menge = alle Stories → das
 *           Ergebnis ist identisch zum server-feature.status; in diesem Fall
 *           wird feature.status direkt weiterverwendet (keine doppelte
 *           Berechnung, siehe filteredProjects-useMemo).
 *   AC3  — Drift-Gate: computeFeatureStatus lebt EINMAL in ../../src/featureStatus.js
 *           (dependency-frei, kein fs/path/os-Import) und wird SOWOHL von
 *           src/BoardAggregator.js ALS AUCH von dieser Datei importiert — kein
 *           Client-Duplikat nötig (Cross-Build-Import ist praktikabel: die
 *           Vite-Workspace-Root-Erkennung findet den repo-weiten package-lock.json
 *           oberhalb von client/, dadurch ist src/ innerhalb des Vite-fs-Zugriffs;
 *           featureStatus.js selbst importiert nichts Node-/Browser-Spezifisches
 *           → verifiziert per `npm run build`).
 *   AC4  — Das Pseudo-Feature `_orphaned` bekommt nie einen abgeleiteten Badge
 *           (status bleibt null, unangetastet von der AC1-Ableitung).
 *   AC5  — Bei aktivem einschränkendem Filter werden Features (echt ODER
 *           `_orphaned`) mit 0 sichtbaren Stories NICHT gerendert; ohne Filter
 *           unverändert (leere echte Features rendern weiter).
 *   AC6  — Der bestehende „Keine Stories passen zum aktiven Filter."-Hinweis
 *           (totalFilteredStories === 0) greift jetzt auch für den Status-Filter,
 *           nicht mehr nur für den Label-Filter (hasRestrictingFilter statt
 *           filterLabel als Bedingung). „Kein Status gewählt"-Hinweis (AC3
 *           studis-kanban-board-ux) unverändert.
 *
 * Story-Status-Lebenszyklus (board-subsystem §9.3, erweitert um ideen-inbox AC1
 * + board-status-verworfen AC1):
 *   Idee | To Do | In Progress | Blocked | In Review | Done | Verworfen
 *
 * A11y (WCAG 2.1 AA):
 *   - <main> mit aria-label „Studis-Kanban-Board".
 *   - aria-busy / aria-live für Ladezustand.
 *   - Sichtbarer Fokusring — KEIN outline:none (coder lesson 2026-05-27).
 *   - Touch-Targets ≥ 44 px für interaktive Elemente.
 *   - Bedeutung nicht allein über Farbe (Status-Badges mit Text).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/board/* Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *
 * @param {{
 *   onNavigate: (view: string) => void,
 *   lockedProject?: string,
 *   onOpenSpec?: (relPath: string) => void,
 * }} props
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { EntityIcon }             from './icons/EntityIcon.jsx';
import { parseEntityLabel }       from './icons/parseEntityLabel.js';
import { IdeaSpecifyChatModal }   from './IdeaSpecifyChatModal.jsx';
import { AreasManageDialog }      from './AreasManageDialog.jsx';
import { FeatureBatchButton }     from './FeatureBatchButton.jsx';
// board-filter-feature-status-consistency AC3 (S-241): geteilte, dependency-freie
// Pure-Funktion — EINE Regel-Quelle mit src/BoardAggregator.js (Cross-Build-Import,
// kein Client-Duplikat).
import { computeFeatureStatus }   from '../../src/featureStatus.js';

// ── Status-Lebensyklus (board-subsystem §9.3) ─────────────────────────────────

/**
 * Canonical story-status lifecycle values.
 * ideen-inbox AC1: „Idee" ist GANZ LINKS einsortiert (vor „To Do") — Front-of-Funnel
 * vor dem eigentlichen Drain-Modell; Reihenfolge bestimmt sowohl Spalten-Rendering
 * (STATUS_LIFECYCLE.map in FeatureRow) als auch die Filter-Checkbox-Reihenfolge.
 */
// board-status-verworfen AC1/AC3/AC4 (S-242): „Verworfen" ist das 7. (letzte)
// Element — rechts neben „Done" als eigene Spalte + Filter-Checkbox; speist
// automatisch Spalten (gridTemplateColumns), Spalten-Gruppierung (byStatus)
// und Filter-Checkbox-Liste (statusOptions) — eine Änderung, drei Wirkungen.
const STATUS_LIFECYCLE = ['Idee', 'To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Verworfen'];

/**
 * "Done" story-statuses for rollup calculation (AC5).
 * 'done' is a defensive fallback for non-canonical backend values.
 */
const DONE_STATUSES = new Set(['Done', 'done']);

/**
 * Terminal story-statuses for the archive-criterion (board-feature-archive
 * V7/AC9, S-244): `Verworfen` (Won't-Do) zählt wie `Done` als terminal — eine
 * Verworfen-Story blockiert das Archivieren eines Features nicht mehr. NICHT
 * für die "Done"-Rollup-Zählung (AC5, Zeile ~420) verwenden — dort bleibt nur
 * `Done` gemeint.
 */
const ARCHIVABLE_TERMINAL_STATUSES = new Set(['Done', 'done', 'Verworfen', 'verworfen']);

// ── Feature-collapse helpers (board-feature-collapse) ─────────────────────────

/**
 * localStorage key for a project slug.
 * Key: `boardview.collapsed.<slug>` → JSON `{ "collapsed": ["F-012","F-018"] }`
 * (AC5: localStorage pro Projekt)
 *
 * @param {string} slug
 * @returns {string}
 */
function collapseKey(slug) {
  return `boardview.collapsed.${slug}`;
}

/**
 * Load collapsed feature IDs from localStorage.
 * Returns null when no persisted state exists for this slug.
 * Returns an empty Set when persisted but nothing is collapsed.
 * Falls back silently to null on any error (AC5: defektes localStorage → Default).
 *
 * @param {string} slug
 * @returns {Set<string>|null}
 */
function loadCollapsedSet(slug) {
  try {
    const raw = window.localStorage.getItem(collapseKey(slug));
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.collapsed)) return null;
    return new Set(parsed.collapsed);
  } catch {
    return null;
  }
}

/**
 * Persist collapsed feature IDs to localStorage.
 * Silently ignores errors (quota, security, …) (AC5).
 *
 * @param {string} slug
 * @param {Set<string>} collapsedSet
 */
function saveCollapsedSet(slug, collapsedSet) {
  try {
    window.localStorage.setItem(
      collapseKey(slug),
      JSON.stringify({ collapsed: Array.from(collapsedSet) }),
    );
  } catch {
    // Silently ignore — AC5: kein Crash bei defektem localStorage
  }
}

// ── „Archiv anzeigen"-Schalter (board-feature-archive AC6/V6) ─────────────────

/**
 * localStorage key for the board-wide „Archiv anzeigen"-toggle.
 * Purely local display state (Nicht-Ziel: teamweite/serverseitige Persistenz).
 */
const SHOW_ARCHIVED_KEY = 'boardview.showArchived';

/**
 * Load the persisted „Archiv anzeigen"-toggle state.
 * Default: `false` (Standardansicht). Falls back silently to `false` on any
 * error (Edge-Case: defektes localStorage → stiller Default (aus), kein Crash).
 *
 * @returns {boolean}
 */
function loadShowArchived() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(SHOW_ARCHIVED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the „Archiv anzeigen"-toggle state. Silently ignores errors
 * (quota/security) — reiner Anzeige-Zustand, kein Crash bei defektem localStorage.
 *
 * @param {boolean} value
 */
function saveShowArchived(value) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(SHOW_ARCHIVED_KEY, value ? 'true' : 'false');
  } catch {
    // Silently ignore — kein Crash bei defektem localStorage.
  }
}

/**
 * Determine whether a feature counts as "done" for the default-mixed rule (AC3).
 * Done = (rollup.done === rollup.total && rollup.total > 0) OR
 *        feature.status ∈ {'Done', 'Archived'}.
 *
 * @param {{ status?: string, progress?: unknown, stories?: Array<{status: string}> }} feature
 * @returns {boolean}
 */
function isFeatureDone(feature) {
  if (feature.status === 'Done' || feature.status === 'Archived') return true;
  const rollup = computeRollup(feature);
  return rollup.total > 0 && rollup.done === rollup.total;
}

/**
 * Compute the default collapsed set for a list of features (AC3 — Default „Gemischt").
 * Erledigte Features eingeklappt, übrige ausgeklappt.
 *
 * @param {Array<{id: string}>} features
 * @returns {Set<string>}
 */
function computeDefaultCollapsed(features) {
  const collapsed = new Set();
  for (const f of features) {
    if (isFeatureDone(f)) collapsed.add(f.id);
  }
  return collapsed;
}

/**
 * Derive the effective collapsed set for a project:
 * - If localStorage has state → use it; new features not yet stored follow default.
 * - Otherwise → default „Gemischt" from computeDefaultCollapsed.
 *
 * @param {string} slug
 * @param {Array<{id: string}>} features
 * @returns {Set<string>}
 */
function resolveCollapsedSet(slug, features) {
  const stored = loadCollapsedSet(slug);
  if (stored === null) {
    // No persisted state → default „Gemischt" (AC3/V3)
    return computeDefaultCollapsed(features);
  }
  // Persisted state exists → use it as-is (AC5: gespeicherter Zustand hat Vorrang).
  // Our format stores only collapsed IDs.
  // - Feature in stored → collapsed.
  // - Feature absent from stored → was explicitly expanded (or "Alle ausklappen" was used).
  // Spec V5: "gespeicherter Feature-Zustand vorhanden → diesen verwenden"
  return new Set(stored);
}

// ── Rollup helper ─────────────────────────────────────────────────────────────

/**
 * Compute display-rollup for a feature (AC5).
 *
 * If `feature.progress` is a non-null object with numeric `done` and `total`,
 * use it directly. Otherwise compute read-only from child story statuses.
 *
 * @param {{ progress?: unknown, stories: Array<{status: string}> }} feature
 * @returns {{ done: number, total: number }}
 */
function computeRollup(feature) {
  const p = feature.progress;
  if (
    p != null &&
    typeof p === 'object' &&
    typeof p.done === 'number' &&
    typeof p.total === 'number'
  ) {
    return { done: p.done, total: p.total };
  }
  // Fallback: compute from child stories (read-only, no file writes — AC7)
  const stories = Array.isArray(feature.stories) ? feature.stories : [];
  const total = stories.length;
  const done = stories.filter((s) => DONE_STATUSES.has(s.status)).length;
  return { done, total };
}

// ── BoardView ─────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   onNavigate: (view: string) => void,
 *   lockedProject?: string,
 * }} props
 *   lockedProject — when set (Cockpit-Modus / F-005), shows that project directly
 *   without project list; project-filter dropdown is hidden (AC6/studis-kanban-board-ux).
 *   When absent (STANDALONE #/board), shows project list first — lazy-load mode (AC6).
 */
export function BoardView({ onNavigate: _onNavigate, lockedProject, onOpenSpec }) {
  // ─── Mode: standalone (lazy) vs cockpit (lockedProject set) ─────────────────
  const isStandalone = !lockedProject;

  // ─── Idee spezifizieren (idea-specify-chat AC1/AC2, S-218) ───────────────────
  // specifyingIdea: { slug, story } | null — welche Idee gerade im Chat-Overlay
  // besprochen wird. Wird sowohl vom Karte-Klick (handleStoryClick, status ===
  // 'Idee') als auch vom „Spezifizieren"-Button (StoryCard) aufgerufen — beide
  // führen zum selben Overlay (AC1).
  const [specifyingIdea, setSpecifyingIdea] = useState(null);
  const specifyTriggerRef = useRef(null);

  // ─── Idee-Finalize-Status (idea-specify-background-status AC3/AC4/AC5, S-230) ─
  // specifyJobs: { [ideaStoryId]: { status: 'running'|'failed'|'auth-expired', jobId, error? } }
  // Hydratisiert + gepollt aus GET …/specify/jobs (nur nicht-`done` Jobs). Speist
  // die Idee-Karten-Badges (AC3 running „wird spezifiziert…", AC4 Fehler-Hinweis).
  const [specifyJobs, setSpecifyJobs] = useState({});
  // Merkt sich die ideaStoryIds, die im letzten Snapshot `running` waren — um den
  // Übergang running→weg (→ `done`) zu erkennen und GENAU EIN Board-Re-Fetch
  // auszulösen (AC5), damit die neue To-Do-Story ohne manuellen Reload erscheint.
  const prevRunningIdeasRef = useRef(new Set());
  // Erhöht sich beim Schließen des Chat-Overlays → triggert eine sofortige
  // Re-Hydration der Idee-Badges (AC5: „direkt nachdem Story anlegen ausgelöst
  // wurde"). Der Server registriert den running-Job synchron VOR dem
  // fire-and-forget-Schließen (AC1), sodass der Badge sofort erscheint.
  const [specifyCloseToken, setSpecifyCloseToken] = useState(0);

  // ─── „Neue Story"-Finalize-Status (story-specify-finalize-visibility AC6, S-240) ─
  // finalizeJob: der PROJEKT-keyed letzte Finalize-Job des aktuellen Projekts
  // ({ status, jobId, error? } | null), gelesen aus GET .../story-specify/finalize.
  // Trägt er no-op/failed/auth-expired, zeigt das Board einen nicht-blockierenden
  // Hinweis. Reload-fest über die Server-Registry (S-239).
  const [finalizeJob, setFinalizeJob] = useState(null);
  // jobId des vom Owner quittierten (ausgeblendeten) Hinweises. Ein NEUER Job
  // (andere jobId) zeigt den Hinweis wieder; ein running/done fällt ohnehin aus
  // dem Fehler-Set → Hinweis verschwindet automatisch.
  const [dismissedFinalizeJobId, setDismissedFinalizeJobId] = useState(null);

  const handleOpenSpecifyChat = useCallback((slug, story, triggerEl) => {
    specifyTriggerRef.current = triggerEl ?? null;
    setSpecifyingIdea({ slug, story });
  }, []);

  const handleCloseSpecifyChat = useCallback(() => {
    setSpecifyingIdea(null);
    // AC5: nach dem Schließen (insb. fire-and-forget nach „Story anlegen") den
    // Idee-Finalize-Status neu abfragen — ein gerade registrierter running-Job
    // erscheint so sofort als Badge und startet das Polling.
    setSpecifyCloseToken((t) => t + 1);
  }, []);

  // ─── Story Detail (AC3/AC4 story-detail-ansicht) ─────────────────────────────
  // selectedStory: { slug, storyId, storyTitle } | null
  const [selectedStory, setSelectedStory] = useState(null);
  // detailState: 'idle'|'loading'|'ok'|'error'
  const [detailState, setDetailState] = useState('idle');
  const [detailData, setDetailData]   = useState(null);
  const [detailError, setDetailError] = useState('');

  // ─── Standalone: project list state (AC6) ───────────────────────────────────
  // listState: 'idle'|'loading'|'ok'|'error'
  const [listState, setListState]   = useState('idle');
  const [listError, setListError]   = useState('');
  /** @type {[Array<{slug:string,feature_count?:number,story_count?:number,error?:string}>, Function]} */
  const [projectList, setProjectList] = useState([]);
  // selectedSlug: the project the user clicked on (null = showing project list)
  const [selectedSlug, setSelectedSlug] = useState(null);

  // ─── Data state: full project loaded on-demand (AC6 standalone) or on mount (cockpit) ─
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  // In cockpit mode: projects = [ lockedProject full data ]
  // In standalone mode: projects = [ selectedProject full data ]
  const [projects, setProjects] = useState([]);

  // ─── Reload trigger (idea-specify-chat AC10-Konsument, S-218) ───────────────
  // Incremented after a successful Finalize (onSpecified) to force a re-fetch
  // in Cockpit-Modus (the load-effect below depends on it). Standalone-Modus
  // re-fetched stattdessen direkt über handleProjectSelect (imperativ).
  const [reloadToken, setReloadToken] = useState(0);

  // ─── „Archiv anzeigen"-Schalter (board-feature-archive AC6/V6) ───────────────
  // showArchived: Default aus (Standardansicht). Ist er an, fetchen die Board-
  // Loads mit `?includeArchived=true` (V3) und archivierte Features/Stories
  // erscheinen read-only + klar markiert. Reiner Anzeige-Zustand, lokal in
  // localStorage gemerkt (Edge-Case: defektes localStorage → stiller Default aus).
  const [showArchived, setShowArchived] = useState(loadShowArchived);
  const handleToggleArchived = useCallback(() => {
    setShowArchived((prev) => {
      const next = !prev;
      saveShowArchived(next);
      return next;
    });
  }, []);

  // ─── Filter state (AC2, AC3, AC4) ───────────────────────────────────────────
  // AC2: default = all status selected (new Set(STATUS_LIFECYCLE), now 6 incl. „Idee")
  const [filterProject, setFilterProject] = useState(lockedProject ?? '');
  const [filterStatus, setFilterStatus]   = useState(() => new Set(STATUS_LIFECYCLE)); // AC2: alle vorausgewählt
  const [filterLabel, setFilterLabel]     = useState('');

  // ─── Collapse state (AC1/AC3/AC4/AC5 board-feature-collapse) ─────────────────
  // collapsedIds: Set<featureId> — which features are currently collapsed.
  // Initialized synchronously in the fetch callbacks alongside setProjects.
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());

  /**
   * Toggle a single feature's collapsed state and persist it.
   * AC1: ein-/ausklappen. AC5: Persistenz.
   */
  const handleCollapseToggle = useCallback((featureId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(featureId)) {
        next.delete(featureId);
      } else {
        next.add(featureId);
      }
      // Persist per current project slug (AC5)
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Collapse all features of the current project (AC4).
   */
  const handleCollapseAll = useCallback(() => {
    setCollapsedIds(() => {
      const allIds = (projects[0]?.features ?? []).map((f) => f.id);
      const next = new Set(allIds);
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Expand all features of the current project (AC4).
   */
  const handleExpandAll = useCallback(() => {
    setCollapsedIds(() => {
      const next = new Set();
      const slug = projects[0]?.slug ?? projects[0]?.project_slug ?? projects[0]?.repo_path ?? null;
      if (slug) saveCollapsedSet(slug, next);
      return next;
    });
  }, [projects]);

  /**
   * Whether ANY filter is restricting the view — used for AC6 filter-wechselwirkung.
   * A restricting filter = status filter not all-selected, OR label filter active.
   */
  const hasRestrictingFilter = useMemo(() => {
    return filterStatus.size < STATUS_LIFECYCLE.length || Boolean(filterLabel);
  }, [filterStatus, filterLabel]);

  // ─── STANDALONE: load project list on mount (AC6) ───────────────────────────
  useEffect(() => {
    if (!isStandalone) return;

    let cancelled = false;
    setListState('loading');
    setListError('');

    fetch('/api/board/projects/list')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setProjectList(data.projects ?? []);
        setListState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setListError(err.message || 'Netzwerkfehler');
        setListState('error');
      });

    return () => { cancelled = true; };
  }, [isStandalone]);

  // ─── COCKPIT: load the locked project on mount (AC6 cockpit mode) ────────────
  useEffect(() => {
    if (isStandalone) return;
    if (!lockedProject) return;

    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch(`/api/board/projects/${encodeURIComponent(lockedProject)}${showArchived ? '?includeArchived=true' : ''}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const proj = data.project ?? null;
        const projList = proj ? [proj] : [];
        setProjects(projList);
        // AC3/AC5: resolve collapse state synchronously with project load
        if (proj) {
          const slug = proj.slug ?? proj.project_slug ?? proj.repo_path ?? null;
          if (slug) setCollapsedIds(resolveCollapsedSet(slug, proj.features ?? []));
        }
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        // Fallback: try the full list endpoint so Cockpit doesn't break
        // if the slug doesn't match (e.g. lockedProject = repo path not slug)
        fetch(`/api/board/projects${showArchived ? '?includeArchived=true' : ''}`)
          .then((r) => {
            if (!r.ok) return Promise.reject(new Error(`HTTP ${r.status}`));
            return r.json();
          })
          .then((data) => {
            if (cancelled) return;
            const all = data.projects ?? [];
            const filtered = all.filter((p) => {
              const slug = p.slug || p.project_slug || p.repo_path || '';
              return slug === lockedProject;
            });
            const projList = filtered.length > 0 ? filtered : all;
            setProjects(projList);
            // AC3/AC5: resolve collapse state for fallback
            if (projList.length > 0) {
              const p = projList[0];
              const slug = p.slug ?? p.project_slug ?? p.repo_path ?? null;
              if (slug) setCollapsedIds(resolveCollapsedSet(slug, p.features ?? []));
            }
            setLoadState('ok');
          })
          .catch((err2) => {
            if (cancelled) return;
            setLoadError(err2.message || err.message || 'Netzwerkfehler');
            setLoadState('error');
          });
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedProject, reloadToken, showArchived]); // re-run if locked project changes, a reload was requested (AC10), OR the „Archiv anzeigen"-toggle flips (AC6)

  // ─── STANDALONE: load single project when user clicks (AC6) ─────────────────
  const handleProjectSelect = useCallback((slug) => {
    setSelectedSlug(slug);
    setLoadState('loading');
    setLoadError('');
    setProjects([]);
    setCollapsedIds(new Set()); // reset while loading

    fetch(`/api/board/projects/${encodeURIComponent(slug)}${showArchived ? '?includeArchived=true' : ''}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        const proj = data.project ?? null;
        setProjects(proj ? [proj] : []);
        // AC3/AC5: resolve collapse state synchronously with project load
        if (proj) {
          const projSlug = proj.slug ?? proj.project_slug ?? proj.repo_path ?? null;
          if (projSlug) setCollapsedIds(resolveCollapsedSet(projSlug, proj.features ?? []));
        }
        setLoadState('ok');
      })
      .catch((err) => {
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });
  }, [showArchived]);

  // ─── „Archiv anzeigen"-Toggle → aktuelles Projekt neu laden (AC6) ────────────
  // Cockpit re-fetcht bereits über den Load-Effect (showArchived in dessen Deps).
  // Standalone lädt imperativ über handleProjectSelect — daher hier ein separater
  // Effect, der beim Umschalten (nicht beim Mount) das aktuell gewählte Projekt
  // mit dem neuen includeArchived-Signal neu holt.
  const archivedToggleMountRef = useRef(false);
  useEffect(() => {
    if (!archivedToggleMountRef.current) { archivedToggleMountRef.current = true; return; }
    if (isStandalone && selectedSlug) {
      handleProjectSelect(selectedSlug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  // ─── LIVE: SSE-Abonnent GET /api/board/events (board-live-sse AC13–AC17) ─────
  // Genau EINE EventSource pro Mount (AC13) — der Mount-Effekt hat bewusst KEINE
  // Abhängigkeiten; alles Veränderliche (angezeigter Slug, Modus, Re-Fetch-
  // Callback) fließt über Refs hinein, damit Re-Render nie eine zweite
  // Verbindung öffnet. Ein Event für das AKTUELL angezeigte Projekt löst GENAU
  // EINEN Re-Fetch über den BESTEHENDEN Ladepfad aus (Cockpit: reloadToken-
  // Bump; Standalone: handleProjectSelect) — AC14. Fremde Slugs oder keine
  // Auswahl → kein Re-Fetch (AC15). Verbindungsfehler degradieren still
  // (Reconnect ist EventSource-Standard, manueller Refresh bleibt Fallback —
  // AC16). Überlappende Ladevorgänge verhindert der bestehende cancelled-Guard
  // des Ladepfads (AC17).
  const sseDisplayedSlugRef = useRef(null);
  const sseStandaloneRef = useRef(isStandalone);
  const sseSelectRef = useRef(handleProjectSelect);
  useEffect(() => {
    sseDisplayedSlugRef.current = isStandalone
      ? selectedSlug
      : (projects[0]?.slug ?? projects[0]?.project_slug ?? lockedProject ?? null);
    sseStandaloneRef.current = isStandalone;
    sseSelectRef.current = handleProjectSelect;
  }, [isStandalone, selectedSlug, projects, lockedProject, handleProjectSelect]);
  // Verbindungs-Schlüssel: nur wenn ein Projekt ANGEZEIGT wird, existiert eine
  // Verbindung (Standalone-Projektliste ohne Auswahl → keine EventSource, AC15);
  // Projektwechsel schließt die alte und öffnet eine neue (AC13).
  const sseKey = isStandalone ? selectedSlug : lockedProject;
  useEffect(() => {
    if (!sseKey) return undefined; // kein angezeigtes Projekt → keine Verbindung (AC15)
    if (typeof EventSource === 'undefined') return undefined; // Umgebung ohne SSE → still degradieren (AC16)
    let es;
    try {
      es = new EventSource('/api/board/events');
    } catch {
      return undefined; // AC16: keine Fehlermauer — Board bleibt über manuellen Refresh nutzbar
    }
    es.onmessage = (event) => {
      let slug;
      try {
        slug = JSON.parse(event.data)?.slug;
      } catch {
        return; // malformte Frames still ignorieren
      }
      if (!slug || slug !== sseDisplayedSlugRef.current) return; // AC15
      if (sseStandaloneRef.current) {
        sseSelectRef.current(slug); // Standalone: bestehender imperativer Ladepfad
      } else {
        setReloadToken((t) => t + 1); // Cockpit: bestehender Load-Effect (AC10-Mechanik)
      }
    };
    // Best-effort-Handler: Fehler nie eskalieren, Verbindung NICHT schließen —
    // Reconnect übernimmt der EventSource-Standard (AC16).
    es.onerror = () => {};
    return () => { es.close(); };
  }, [sseKey]);

  // ─── STANDALONE: back to project list ────────────────────────────────────────
  const handleBackToList = useCallback(() => {
    setSelectedSlug(null);
    setProjects([]);
    setLoadState('idle');
    setLoadError('');
    // Reset filters when returning to list
    setFilterStatus(new Set(STATUS_LIFECYCLE));
    setFilterLabel('');
  }, []);

  // ─── Story click → Detail-Ansicht (AC3 story-detail-ansicht) ─────────────────
  // slug: the current project slug (from standalone selectedSlug or lockedProject)
  // idea-specify-chat AC1 (S-218): ein Klick auf eine Idee-Karte (status === 'Idee')
  // öffnet stattdessen das Spezifizieren-Chat-Overlay (handleOpenSpecifyChat) —
  // keine Detail-Ansicht, kein Tab-Wechsel.
  const handleStoryClick = useCallback((slug, story, triggerEl) => {
    if (story.status === 'Idee') {
      handleOpenSpecifyChat(slug, story, triggerEl);
      return;
    }

    setSelectedStory({ slug, storyId: story.id, storyTitle: story.title || story.id });
    setDetailState('loading');
    setDetailData(null);
    setDetailError('');

    fetch(`/api/board/projects/${encodeURIComponent(slug)}/stories/${encodeURIComponent(story.id)}/detail`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        setDetailData(data.detail ?? null);
        setDetailState('ok');
      })
      .catch((err) => {
        setDetailError(err.message || 'Netzwerkfehler');
        setDetailState('error');
      });
  }, [handleOpenSpecifyChat]);

  // ─── onSpecified: Board-Re-Fetch nach erfolgreichem Finalize (AC10) ──────────
  // Cockpit-Modus: reloadToken hochzählen → Load-Effect (oben) fetcht neu.
  // Standalone-Modus: direkt handleProjectSelect erneut aufrufen (imperativer
  // Re-Fetch desselben Projekts, wiederverwendet den bestehenden Mechanismus).
  const handleSpecified = useCallback((_slug) => {
    if (isStandalone) {
      if (selectedSlug) handleProjectSelect(selectedSlug);
    } else {
      setReloadToken((t) => t + 1);
    }
  }, [isStandalone, selectedSlug, handleProjectSelect]);

  // ─── Back from story detail → board ─────────────────────────────────────────
  const handleDetailBack = useCallback(() => {
    setSelectedStory(null);
    setDetailState('idle');
    setDetailData(null);
    setDetailError('');
  }, []);

  // ─── Current project slug (for story detail API calls) ───────────────────────
  // In standalone: selectedSlug; in cockpit: lockedProject
  const currentProjectSlug = isStandalone ? selectedSlug : (lockedProject ?? null);

  // ─── Idee-Finalize-Status: Hydratisieren + Polling + Re-Fetch (AC3/AC4/AC5) ──
  // Liest GET …/specify/jobs (nur nicht-`done` Jobs, idea-keyed). Erkennt den
  // Übergang running→weg (→ `done`) und löst GENAU EIN Board-Re-Fetch aus
  // (bestehender reloadToken-/onSpecified-Mechanismus über handleSpecified).
  // Degradiert still bei Netz-/Parse-Fehlern (Robustheit-NFR) — kein Crash.
  const fetchSpecifyJobs = useCallback(async () => {
    const slug = currentProjectSlug;
    if (!slug) return;
    let res;
    try {
      res = await fetch(`/api/board/projects/${encodeURIComponent(slug)}/specify/jobs`);
    } catch {
      return; // Netzwerkfehler → still degradieren (Badge bleibt beim letzten Stand)
    }
    if (!res.ok) return;
    let data;
    try { data = await res.json(); } catch { return; }
    const jobs = (data && typeof data.jobs === 'object' && data.jobs) ? data.jobs : {};

    // running→weg-Erkennung: war eine Idee zuvor `running` und ist jetzt nicht
    // mehr im Snapshot (→ `done`), genau EIN Re-Fetch der Board-Daten (AC5).
    const currentRunning = new Set(
      Object.entries(jobs)
        .filter(([, job]) => job && job.status === 'running')
        .map(([ideaId]) => ideaId),
    );
    let anyDisappeared = false;
    for (const ideaId of prevRunningIdeasRef.current) {
      if (!currentRunning.has(ideaId)) { anyDisappeared = true; break; }
    }
    prevRunningIdeasRef.current = currentRunning;

    setSpecifyJobs(jobs);

    if (anyDisappeared) {
      // Bestehender Re-Fetch-Mechanismus (Cockpit: reloadToken++, Standalone:
      // handleProjectSelect) → neue To-Do-Story erscheint ohne manuellen Reload.
      handleSpecified(slug);
    }
  }, [currentProjectSlug, handleSpecified]);

  // AC5: Board hat ≥1 Idee mit aktivem (running) Finalize-Job?
  const hasRunningSpecifyJob = useMemo(
    () => Object.values(specifyJobs).some((job) => job && job.status === 'running'),
    [specifyJobs],
  );

  // Hydratisieren: bei geladenem Projekt (Board-Load) sowie nach dem Schließen
  // des Chat-Overlays (specifyCloseToken) den Idee-Finalize-Status abfragen.
  useEffect(() => {
    if (!currentProjectSlug || loadState !== 'ok') return;
    fetchSpecifyJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectSlug, loadState, reloadToken, specifyCloseToken]);

  // Polling: NUR solange ≥1 Idee einen running-Job trägt (AC5 — kein Dauer-Poll
  // im Ruhezustand). Sobald alle Jobs terminal sind, wird das Intervall geräumt.
  useEffect(() => {
    if (!hasRunningSpecifyJob) return; // Ruhezustand → kein Poll
    const POLL_MS = 4000;
    const intervalId = setInterval(() => { fetchSpecifyJobs(); }, POLL_MS);
    return () => clearInterval(intervalId);
  }, [hasRunningSpecifyJob, fetchSpecifyJobs]);

  // Beim Projektwechsel den Badge-Status + running-Merker zurücksetzen (kein
  // Nachwirken alter Idee-Jobs auf ein anderes Projekt). Ebenso den projekt-keyed
  // „Neue Story"-Finalize-Status + Dismiss-Merker (AC6, S-240).
  useEffect(() => {
    setSpecifyJobs({});
    prevRunningIdeasRef.current = new Set();
    setFinalizeJob(null);
    setDismissedFinalizeJobId(null);
  }, [currentProjectSlug]);

  // ─── „Neue Story"-Finalize-Hinweis: Hydratisieren + Polling (AC6, S-240) ─────
  // Liest den PROJEKT-keyed letzten Finalize-Job (GET .../story-specify/finalize).
  // Reload-fest über die Server-Registry (S-239): auch ein no-op/failed aus einer
  // früheren Session/Tab wird beim Board-Load sichtbar. Degradiert bei Netz-/
  // Parse-Fehlern still (kein Crash, kein Hinweis).
  const fetchFinalizeJob = useCallback(async () => {
    const slug = currentProjectSlug;
    if (!slug) return;
    let res;
    try {
      res = await fetch(`/api/board/projects/${encodeURIComponent(slug)}/story-specify/finalize`);
    } catch {
      return; // Netzwerkfehler → still degradieren
    }
    if (!res.ok) return;
    let data;
    try { data = await res.json(); } catch { return; }
    const job = (data && typeof data.job === 'object') ? data.job : null;
    setFinalizeJob(job);
  }, [currentProjectSlug]);

  // Der letzte Finalize läuft noch → gepollt werden (AC6). Ist er terminal, wird
  // nicht mehr gepollt (Ruhezustand).
  const hasRunningFinalizeJob = finalizeJob?.status === 'running';

  // Hinweis-Status: no-op/failed/auth-expired = retry-würdiger Fehlausgang; alles
  // andere (running/done/null) zeigt keinen Hinweis. Der Hinweis erscheint nur,
  // solange der Owner ihn nicht für GENAU diesen Job quittiert hat.
  const finalizeHintStatus =
    finalizeJob && ['no-op', 'failed', 'auth-expired'].includes(finalizeJob.status)
      ? finalizeJob.status
      : null;
  const showFinalizeHint =
    finalizeHintStatus !== null && finalizeJob.jobId !== dismissedFinalizeJobId;

  // Hydratisieren: bei geladenem Projekt (Board-Load / Re-Fetch) den projekt-keyed
  // Finalize-Status abfragen.
  useEffect(() => {
    if (!currentProjectSlug || loadState !== 'ok') return;
    fetchFinalizeJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectSlug, loadState, reloadToken]);

  // Polling: NUR solange der letzte Finalize-Job `running` ist (AC6 — kein
  // Dauer-Poll im Ruhezustand). Sobald er terminal ist, wird das Intervall
  // geräumt.
  useEffect(() => {
    if (!hasRunningFinalizeJob) return; // Ruhezustand → kein Poll
    const POLL_MS = 4000;
    const intervalId = setInterval(() => { fetchFinalizeJob(); }, POLL_MS);
    return () => clearInterval(intervalId);
  }, [hasRunningFinalizeJob, fetchFinalizeJob]);

  // ─── Archivierbarkeit + Archiv-Schreibpfad (board-storys-archivieren AC6/V1, ──
  // ─── S-294 — löst die feature-basierte Zählung aus board-feature-archive ab) ──
  // Zählt die aktuell archivierbaren STORYS (nicht mehr Features) NACH V1 aus
  // den bereits geladenen (UNGEFILTERTEN) Board-Daten: eine Story ist
  // archivierbar, wenn ihr status terminal ist (`Done` ODER `Verworfen`) UND
  // sie NICHT bereits archiviert ist (`archived !== true`) — UNABHÄNGIG vom
  // Status der Geschwister-Storys im selben Feature (anders als die
  // superseded Feature-Ebenen-Regel: dort musste JEDE Story eines Features
  // terminal sein). Deckungsgleich mit dem Backend-Kriterium
  // `BoardWriter.archiveDoneStories()` (src/BoardWriter.js), das ebenfalls
  // rein pro Story-YAML entscheidet, unabhängig vom Eltern-Feature. Bewusst
  // aus `projects` (roh) statt `filteredProjects`, damit ein aktiver Status-/
  // Label-Filter die Zählung nicht verfälscht.
  const archivable = useMemo(() => {
    let storyCount = 0;
    for (const p of projects) {
      if (p.error) continue;
      for (const f of p.features ?? []) {
        const st = Array.isArray(f.stories) ? f.stories : [];
        for (const s of st) {
          if (s.archived === true) continue; // V1: bereits archiviert
          if (!ARCHIVABLE_TERMINAL_STATUSES.has(s.status)) continue; // V1: nicht terminal
          storyCount += 1;
        }
      }
    }
    return { storyCount };
  }, [projects]);

  // Archiv-Schreibpfad (AC6-Bestätigen): POST .../archive-done-stories und
  // danach die Übersicht neu laden (Rescan — bestehender handleSpecified-
  // Re-Fetch-Weg). Wirft bei Fehler (409/5xx/Netz) eine secret-freie,
  // nutzerlesbare Meldung — die FilterBar zeigt sie nicht-blockierend im
  // Dialog, ohne die Ansicht zu zerstören (AC6).
  const handleArchiveDone = useCallback(async () => {
    const slug = currentProjectSlug;
    if (!slug) throw new Error('Kein Projekt geladen.');
    let res;
    try {
      res = await fetch(`/api/board/projects/${encodeURIComponent(slug)}/archive-done-stories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch {
      throw new Error('Netzwerkfehler — bitte erneut versuchen.');
    }
    if (!res.ok) {
      if (res.status === 409) {
        throw new Error('Board ist gerade beschäftigt — bitte später erneut versuchen.');
      }
      throw new Error(`Archivieren fehlgeschlagen (HTTP ${res.status}).`);
    }
    // Erfolg → Übersicht neu laden (Rescan); die archivierten Storys
    // verschwinden aus der Standardansicht, die Bereichs-Kacheln (Features)
    // bleiben unangetastet. handleSpecified ist der generische Board-Re-Fetch
    // (Cockpit: reloadToken++, Standalone: handleProjectSelect).
    handleSpecified(slug);
  }, [currentProjectSlug, handleSpecified]);

  // ─── Derived: project options for filter dropdown (only in cockpit mode) ─────
  const projectOptions = useMemo(() => {
    return projects
      .filter((p) => !p.error)
      .map((p) => p.slug || p.project_slug || p.repo_path || '?')
      .filter(Boolean);
  }, [projects]);

  // ─── Derived: all label options for filter dropdown ──────────────────────────
  const labelOptions = useMemo(() => {
    const labels = new Set();
    for (const project of projects) {
      if (project.error) continue;
      for (const feature of project.features ?? []) {
        for (const story of feature.stories ?? []) {
          for (const lbl of story.labels ?? []) {
            if (lbl) labels.add(lbl);
          }
        }
      }
    }
    return Array.from(labels).sort();
  }, [projects]);

  // ─── Derived: filtered view ───────────────────────────────────────────────────
  const filteredProjects = useMemo(() => {
    return projects
      .filter((p) => {
        if (!filterProject) return true;
        const slug = p.slug || p.project_slug || p.repo_path || '';
        return slug === filterProject;
      })
      .map((p) => {
        if (p.error) return p;
        const filteredFeatures = (p.features ?? [])
          .map((f) => {
            const filteredStories = (f.stories ?? []).filter((s) => {
              // AC2/AC3: filterStatus is always a non-empty Set (all STATUS_LIFECYCLE by default);
              // empty Set = AC3 scenario → no stories shown
              if (!filterStatus.has(s.status)) return false;
              if (filterLabel && !(s.labels ?? []).includes(filterLabel)) return false;
              return true;
            });
            // board-filter-feature-status-consistency AC1/AC2/AC4 (S-241): Badge aus
            // der SICHTBAREN (gefilterten) Story-Menge ableiten, sobald ein
            // einschränkender Filter aktiv ist — ausser für `_orphaned` (bleibt
            // status:null, AC4). Ohne aktiven Filter ist die sichtbare Menge = alle
            // Stories -> feature.status (server-Wert) direkt weiterverwenden
            // (identisches Ergebnis, AC2 — keine doppelte Berechnung).
            const isOrphaned = f._orphaned === true || f.id === '_orphaned';
            const status = !isOrphaned && hasRestrictingFilter
              ? computeFeatureStatus(filteredStories)
              : f.status;
            return { ...f, stories: filteredStories, status };
          })
          // AC5: bei aktivem einschränkendem Filter Features (echt oder `_orphaned`)
          // ohne sichtbare Story ausblenden; ohne Filter unverändert (leere echte
          // Features rendern weiter).
          .filter((f) => !hasRestrictingFilter || (f.stories ?? []).length > 0);
        return { ...p, features: filteredFeatures };
      });
  }, [projects, filterProject, filterStatus, filterLabel, hasRestrictingFilter]);

  // Total stories after filtering — used to detect "filter eliminates all" or AC3 empty-set
  const totalFilteredStories = useMemo(() => {
    return filteredProjects.reduce(
      (acc, p) =>
        acc + (p.features ?? []).reduce((a, f) => a + (f.stories ?? []).length, 0),
      0,
    );
  }, [filteredProjects]);

  // AC3: all statuses deselected
  const allStatusDeselected = filterStatus.size === 0;

  const isEmpty = loadState === 'ok' && projects.length === 0;
  const hasProjects = loadState === 'ok' && projects.length > 0;

  // ─── Render ───────────────────────────────────────────────────────────────────

  // ─── Story Detail View (AC3 story-detail-ansicht) — overlay ─────────────────
  if (selectedStory !== null) {
    return (
      <StoryDetailView
        story={selectedStory}
        detailState={detailState}
        detailData={detailData}
        detailError={detailError}
        onBack={handleDetailBack}
      />
    );
  }

  return (
    <main style={styles.main} aria-label="Studis-Kanban-Board">
      <h1 style={styles.h1}>Studis-Kanban-Board</h1>

      {/* idea-specify-chat AC1 (S-218): Chat-Overlay über dem Board (kein Tab-Wechsel) */}
      {specifyingIdea && (
        <IdeaSpecifyChatModal
          projectSlug={specifyingIdea.slug}
          story={specifyingIdea.story}
          onClose={handleCloseSpecifyChat}
          onSpecified={handleSpecified}
          triggerRef={specifyTriggerRef}
        />
      )}

      {/* story-specify-finalize-visibility AC6 (S-240): nicht-blockierender,
          secret-freier Board-Hinweis, wenn der letzte projekt-keyed „Neue Story"-
          Finalize-Lauf no-op/failed/auth-expired trägt. Text + ⚠-Icon (nicht nur
          Farbe), role=status/aria-live; quittierbar (✕). Blockiert die
          Board-Nutzung nicht (reines Banner über den Spalten). */}
      {showFinalizeHint && (
        <div
          role="status"
          aria-live="polite"
          style={styles.finalizeHint}
          data-testid="board-finalize-hint"
        >
          <span style={styles.finalizeHintIcon} aria-hidden="true">⚠</span>
          <span style={styles.finalizeHintText}>
            Story-Erstellung fehlgeschlagen — erneut versuchen.
          </span>
          <button
            type="button"
            style={styles.finalizeHintDismiss}
            onClick={() => setDismissedFinalizeJobId(finalizeJob.jobId)}
            aria-label="Hinweis ausblenden"
            data-testid="board-finalize-hint-dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── STANDALONE: Project list (AC6) ─────────────────────────── */}
      {isStandalone && selectedSlug === null && (
        <>
          {listState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Projektliste…
            </div>
          )}
          {listState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Projektliste: {listError}
            </div>
          )}
          {listState === 'ok' && projectList.length === 0 && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}
          {listState === 'ok' && projectList.length > 0 && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {projectList.map((item) => (
                <ProjectListItem
                  key={item.slug}
                  item={item}
                  onSelect={handleProjectSelect}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── STANDALONE: Single project loaded (AC6) ────────────────── */}
      {isStandalone && selectedSlug !== null && (
        <>
          {/* Back to list */}
          <button
            type="button"
            style={styles.backBtn}
            onClick={handleBackToList}
            aria-label="Zurück zur Projektliste"
            data-testid="board-back-btn"
          >
            ← Projektliste
          </button>

          {/* Filter bar — shown when data is loaded (standalone project view) */}
          {hasProjects && (
            <FilterBar
              projects={projectOptions}
              statusOptions={STATUS_LIFECYCLE}
              labelOptions={labelOptions}
              filterProject={filterProject}
              filterStatus={filterStatus}
              filterLabel={filterLabel}
              onProjectChange={setFilterProject}
              onStatusChange={setFilterStatus}
              onLabelChange={setFilterLabel}
              hideProjectFilter={true}
              collapsedIds={collapsedIds}
              allFeatureIds={(projects[0]?.features ?? []).map((f) => f.id)}
              onCollapseAll={handleCollapseAll}
              onExpandAll={handleExpandAll}
              archivableStoryCount={archivable.storyCount}
              onArchiveDone={handleArchiveDone}
              showArchived={showArchived}
              onToggleArchived={handleToggleArchived}
              projectSlug={currentProjectSlug}
            />
          )}

          {/* Loading */}
          {loadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Projekt-Daten…
            </div>
          )}
          {/* Error */}
          {loadState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Board-Daten: {loadError}
            </div>
          )}
          {/* Empty */}
          {isEmpty && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}
          {/* AC3: all statuses deselected */}
          {hasProjects && allStatusDeselected && (
            <div role="status" style={styles.statusMsg} data-testid="no-status-hint">
              Kein Status gewählt — bitte mindestens einen wählen.
            </div>
          )}
          {/* Project content */}
          {hasProjects && !allStatusDeselected && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {filteredProjects.map((project) => (
                <ProjectSection
                  key={project.slug ?? project.repo_path ?? project.project_slug}
                  project={project}
                  onOpenSpec={onOpenSpec}
                  onStoryClick={currentProjectSlug
                    ? (story, triggerEl) => handleStoryClick(currentProjectSlug, story, triggerEl)
                    : null}
                  onSpecifyIdea={currentProjectSlug
                    ? (story, triggerEl) => handleOpenSpecifyChat(currentProjectSlug, story, triggerEl)
                    : null}
                  collapsedIds={collapsedIds}
                  onCollapseToggle={handleCollapseToggle}
                  hasRestrictingFilter={hasRestrictingFilter}
                  specifyJobs={specifyJobs}
                />
              ))}
              {filteredProjects.length === 0 && (filterProject || filterStatus.size > 0 || filterLabel) && (
                <div role="status" style={styles.statusMsg}>
                  Keine Projekte / Stories passen zum aktuellen Filter.
                </div>
              )}
              {filteredProjects.length > 0 && totalFilteredStories === 0 && hasRestrictingFilter && (
                <div role="status" style={styles.statusMsg}>
                  Keine Stories passen zum aktiven Filter.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── COCKPIT (lockedProject set — F-005): direct project view ── */}
      {!isStandalone && (
        <>
          {/* Filter bar — shown when data is loaded */}
          {hasProjects && (
            <FilterBar
              projects={projectOptions}
              statusOptions={STATUS_LIFECYCLE}
              labelOptions={labelOptions}
              filterProject={filterProject}
              filterStatus={filterStatus}
              filterLabel={filterLabel}
              onProjectChange={setFilterProject}
              onStatusChange={setFilterStatus}
              onLabelChange={setFilterLabel}
              hideProjectFilter={true}
              collapsedIds={collapsedIds}
              allFeatureIds={(projects[0]?.features ?? []).map((f) => f.id)}
              onCollapseAll={handleCollapseAll}
              onExpandAll={handleExpandAll}
              archivableStoryCount={archivable.storyCount}
              onArchiveDone={handleArchiveDone}
              showArchived={showArchived}
              onToggleArchived={handleToggleArchived}
              projectSlug={currentProjectSlug}
            />
          )}

          {/* Loading */}
          {loadState === 'loading' && (
            <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
              Lade Board-Daten…
            </div>
          )}

          {/* Error */}
          {loadState === 'error' && (
            <div role="alert" style={styles.errorMsg}>
              Fehler beim Laden der Board-Daten: {loadError}
            </div>
          )}

          {/* Empty */}
          {isEmpty && (
            <div role="status" style={styles.statusMsg}>
              Keine Projekte gefunden. Board-Roots konfigurieren oder Scan auslösen.
            </div>
          )}

          {/* AC3: all statuses deselected */}
          {hasProjects && allStatusDeselected && (
            <div role="status" style={styles.statusMsg} data-testid="no-status-hint">
              Kein Status gewählt — bitte mindestens einen wählen.
            </div>
          )}

          {/* Project list (AC4) */}
          {hasProjects && !allStatusDeselected && (
            <div style={styles.projectList} role="list" aria-label="Projekte">
              {filteredProjects.map((project) => (
                <ProjectSection
                  key={project.slug ?? project.repo_path ?? project.project_slug}
                  project={project}
                  onOpenSpec={onOpenSpec}
                  onStoryClick={currentProjectSlug
                    ? (story, triggerEl) => handleStoryClick(currentProjectSlug, story, triggerEl)
                    : null}
                  onSpecifyIdea={currentProjectSlug
                    ? (story, triggerEl) => handleOpenSpecifyChat(currentProjectSlug, story, triggerEl)
                    : null}
                  collapsedIds={collapsedIds}
                  onCollapseToggle={handleCollapseToggle}
                  hasRestrictingFilter={hasRestrictingFilter}
                  specifyJobs={specifyJobs}
                />
              ))}
              {filteredProjects.length === 0 && (filterProject || filterStatus.size > 0 || filterLabel) && (
                <div role="status" style={styles.statusMsg}>
                  Keine Projekte / Stories passen zum aktuellen Filter.
                </div>
              )}
              {filteredProjects.length > 0 && totalFilteredStories === 0 && hasRestrictingFilter && (
                <div role="status" style={styles.statusMsg}>
                  Keine Stories passen zum aktiven Filter.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

/**
 * Filter controls for Projekt, Story-Status (popover, AC4) and Label.
 * Also contains Alle-ein-/ausklappen-Schalter (AC4 board-feature-collapse).
 *
 * AC4 (studis-kanban-board-ux): Status-Filter as click-toggle popover.
 *   Button "Status (n/N) ▾" opens a floating panel with checkboxes.
 *   Closes on outside click and Esc. Button carries aria-expanded/aria-controls.
 *
 * AC2 (studis-kanban-board-ux): default = all selected (passed in from parent);
 *   N = statusOptions.length (7 incl. „Idee" [ideen-inbox AC1] + „Verworfen"
 *   [board-status-verworfen AC3]).
 *
 * AC4 (board-feature-collapse): "Alle einklappen" / "Alle ausklappen" Schalter.
 *
 * AC6 (board-storys-archivieren, S-294 — löst AC5/AC7 aus board-feature-archive
 *   ab): Button „Erledigte Storys archivieren" + Bestätigungsabfrage. Der
 *   Button ist deaktiviert, wenn keine Story archivierbar ist
 *   (`archivableStoryCount === 0`); sonst öffnet ein Klick einen fokussierten
 *   Bestätigungsdialog (`role="dialog"`, Fokusfalle/Esc), der die Anzahl
 *   betroffener Storys nennt + darauf hinweist, dass die Bereichs-Kacheln
 *   sichtbar bleiben. Bestätigen ruft `onArchiveDone()` (POST
 *   `.../archive-done-stories` + Rescan, wirft bei Fehler eine secret-freie
 *   Meldung), Abbrechen ändert nichts. Endpoint-Fehler erscheinen
 *   nicht-blockierend im Dialog.
 *
 * @param {{
 *   projects: string[],
 *   statusOptions: string[],
 *   labelOptions: string[],
 *   filterProject: string,
 *   filterStatus: Set<string>,
 *   filterLabel: string,
 *   onProjectChange: (v: string) => void,
 *   onStatusChange: (v: Set<string>) => void,
 *   onLabelChange: (v: string) => void,
 *   hideProjectFilter?: boolean,
 *   collapsedIds?: Set<string>,
 *   allFeatureIds?: string[],
 *   onCollapseAll?: () => void,
 *   onExpandAll?: () => void,
 *   archivableStoryCount?: number,
 *   onArchiveDone?: () => Promise<void>,
 *   showArchived?: boolean,
 *   onToggleArchived?: () => void,
 *   projectSlug?: string|null,
 * }} props
 *
 * AC6/AC7 (board-feature-archive): „Archiv anzeigen"-Schalter — echter Toggle-
 *   Button (`aria-pressed`), Default aus. Umschalten lädt die Board-Daten mit
 *   `includeArchived=true` neu; archivierte Features erscheinen dann read-only +
 *   klar per Text „Archiviert" markiert (nicht nur farblich).
 *
 * AC8/AC9/AC10 (bereichs-modell, S-290): Button „Bereiche verwalten" — sichtbar
 *   sobald ein Projekt geladen ist (`projectSlug` gesetzt); öffnet das modale
 *   `AreasManageDialog` (Anlegen/Umbenennen/Umsortieren/Löschen der
 *   Bereichsliste des Projekts, fokussiertes Dialog-Muster).
 */
function FilterBar({
  projects,
  statusOptions,
  labelOptions,
  filterProject,
  filterStatus,
  filterLabel,
  onProjectChange,
  onStatusChange,
  onLabelChange,
  hideProjectFilter = false,
  collapsedIds,
  allFeatureIds,
  onCollapseAll,
  onExpandAll,
  archivableStoryCount = 0,
  onArchiveDone,
  showArchived = false,
  onToggleArchived,
  projectSlug = null,
}) {
  // AC6 (board-storys-archivieren): Zustand der Archiv-Bestätigungsabfrage.
  //   archiveConfirmOpen — Dialog sichtbar?
  //   archiveState        — 'idle' | 'submitting' | 'error' (POST-Fortschritt)
  //   archiveError        — nicht-blockierende, secret-freie Fehlermeldung
  // archiveTriggerRef merkt den auslösenden Button für die Fokus-Rückgabe (A11y).
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveState, setArchiveState] = useState('idle');
  const [archiveError, setArchiveError] = useState('');
  const archiveTriggerRef = useRef(null);
  const hasArchivable = archivableStoryCount > 0;

  const handleOpenArchiveConfirm = useCallback(() => {
    setArchiveState('idle');
    setArchiveError('');
    setArchiveConfirmOpen(true);
  }, []);

  // AC8/AC9/AC10 (bereichs-modell, S-290): Zustand des „Bereiche verwalten"-Dialogs.
  // areasTriggerRef merkt den auslösenden Button für die Fokus-Rückgabe (A11y).
  const [areasManageOpen, setAreasManageOpen] = useState(false);
  const areasTriggerRef = useRef(null);

  const handleOpenAreasManage = useCallback(() => {
    setAreasManageOpen(true);
  }, []);

  const handleCloseAreasManage = useCallback(() => {
    setAreasManageOpen(false);
  }, []);

  const handleCancelArchive = useCallback(() => {
    setArchiveConfirmOpen(false);
    setArchiveState('idle');
    setArchiveError('');
    archiveTriggerRef.current?.focus(); // Fokus-Rückgabe an den Auslöser (A11y)
  }, []);

  const handleConfirmArchive = useCallback(async () => {
    if (!onArchiveDone) return;
    setArchiveState('submitting');
    setArchiveError('');
    try {
      await onArchiveDone();
      // Erfolg → Dialog schließen; die Übersicht wurde bereits neu geladen.
      setArchiveConfirmOpen(false);
      setArchiveState('idle');
      archiveTriggerRef.current?.focus();
    } catch (err) {
      // AC5: nicht-blockierend — Dialog bleibt offen, Fehler wird angezeigt,
      // Ansicht bleibt intakt, Retry/Abbrechen möglich.
      setArchiveState('error');
      setArchiveError(err?.message || 'Archivieren fehlgeschlagen.');
    }
  }, [onArchiveDone]);
  // AC4 (board-feature-collapse): derive whether any feature is collapsed/expanded
  // to decide which button to show.
  const allCollapsed = useMemo(() => {
    if (!allFeatureIds || allFeatureIds.length === 0 || !collapsedIds) return false;
    return allFeatureIds.every((id) => collapsedIds.has(id));
  }, [allFeatureIds, collapsedIds]);
  // AC4: popover open/close state
  const [popoverOpen, setPopoverOpen] = useState(false);
  const popoverRef = useRef(null);
  const triggerRef = useRef(null);
  const POPOVER_ID = 'board-status-popover';

  // Close on outside click (AC4)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleMouseDown(e) {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [popoverOpen]);

  // Close on Esc (AC4)
  useEffect(() => {
    if (!popoverOpen) return;
    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        setPopoverOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [popoverOpen]);

  /** Toggle a status value in the Set. */
  function handleStatusToggle(status) {
    const next = new Set(filterStatus);
    if (next.has(status)) {
      next.delete(status);
    } else {
      next.add(status);
    }
    onStatusChange(next);
  }

  // AC4: button label "Status (n/N) ▾"
  const checkedCount = filterStatus.size;
  const totalCount   = statusOptions.length;
  const statusLabel  = `Status (${checkedCount}/${totalCount}) ▾`;

  // "Any filter active" determines whether reset button appears.
  // AC2: all selected is NOT a "filter active" state; fewer than all OR label/project IS active.
  const allSelected = checkedCount === totalCount;
  const anyFilterActive =
    (!hideProjectFilter && filterProject) ||
    !allSelected ||
    filterLabel;

  return (
    <div style={styles.filterBar} role="search" aria-label="Board-Filter">
      {/* Projekt filter — hidden in Cockpit or standalone single-project view */}
      {!hideProjectFilter && (
        <>
          <label style={styles.filterLabel} htmlFor="board-filter-project">
            Projekt
          </label>
          <select
            id="board-filter-project"
            style={styles.filterSelect}
            value={filterProject}
            onChange={(e) => onProjectChange(e.target.value)}
            aria-label="Nach Projekt filtern"
          >
            <option value="">Alle Projekte</option>
            {projects.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </>
      )}

      {/* AC4: Status popover trigger button */}
      <div style={styles.popoverContainer}>
        <button
          ref={triggerRef}
          type="button"
          id="board-status-filter-btn"
          style={styles.statusPopoverBtn}
          aria-expanded={popoverOpen}
          aria-controls={POPOVER_ID}
          aria-label={`Status-Filter öffnen: ${checkedCount} von ${totalCount} ausgewählt`}
          onClick={() => setPopoverOpen((prev) => !prev)}
          data-testid="status-filter-btn"
        >
          {statusLabel}
        </button>

        {/* AC4: Popover panel */}
        {popoverOpen && (
          <div
            ref={popoverRef}
            id={POPOVER_ID}
            role="dialog"
            aria-label="Status-Filter"
            style={styles.statusPopover}
            data-testid="status-popover"
          >
            <fieldset
              style={styles.filterFieldset}
              id="board-filter-status-group"
              aria-label="Nach Status filtern"
            >
              <legend style={{ ...styles.filterLabel, marginBottom: 6 }}>Status</legend>
              {/* AC7 (studis-kanban-board-ux): „Alle/Keine"-Toggle als übergeordnete
                  Aktion oberhalb der Checkboxen, leicht nach links versetzt.
                  Logik: alle ausgewählt → alle abwählen (greift V3-Leer-Hinweis),
                  sonst (keiner/teilweise) → alle auswählen. Reine Frontend-Umschaltung. */}
              <button
                type="button"
                style={styles.statusToggleAllBtn}
                onClick={() =>
                  onStatusChange(allSelected ? new Set() : new Set(statusOptions))
                }
                aria-pressed={allSelected}
                aria-label={allSelected ? 'Alle Status abwählen' : 'Alle Status auswählen'}
                data-testid="status-toggle-all-btn"
              >
                {allSelected ? 'Keine' : 'Alle'}
              </button>
              <div style={styles.statusCheckboxCol}>
                {statusOptions.map((s) => {
                  const checked = filterStatus.has(s);
                  const inputId = `board-filter-status-${s.replace(/\s+/g, '-').toLowerCase()}`;
                  return (
                    <label key={s} style={styles.statusCheckboxLabel} htmlFor={inputId}>
                      <input
                        id={inputId}
                        type="checkbox"
                        style={styles.statusCheckbox}
                        checked={checked}
                        onChange={() => handleStatusToggle(s)}
                        aria-label={`Status ${s} ${checked ? 'aktiv' : 'inaktiv'}`}
                      />
                      {s}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        )}
      </div>

      {/* Label filter */}
      <label style={styles.filterLabel} htmlFor="board-filter-label">
        Label
      </label>
      <select
        id="board-filter-label"
        style={styles.filterSelect}
        value={filterLabel}
        onChange={(e) => onLabelChange(e.target.value)}
        aria-label="Nach Label filtern"
      >
        <option value="">Alle Labels</option>
        {labelOptions.map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>

      {/* Reset — shown when any filter deviates from default (AC2 default = all selected) */}
      {anyFilterActive && (
        <button
          type="button"
          style={styles.filterReset}
          onClick={() => {
            onProjectChange('');
            onStatusChange(new Set(STATUS_LIFECYCLE)); // AC2: reset to all selected
            onLabelChange('');
          }}
          aria-label="Filter zurücksetzen"
        >
          Zurücksetzen
        </button>
      )}

      {/* AC4 (board-feature-collapse): „Alle einklappen" / „Alle ausklappen" */}
      {allFeatureIds && allFeatureIds.length > 0 && onCollapseAll && onExpandAll && (
        <button
          type="button"
          style={styles.collapseAllBtn}
          onClick={allCollapsed ? onExpandAll : onCollapseAll}
          aria-label={allCollapsed ? 'Alle Features ausklappen' : 'Alle Features einklappen'}
          aria-pressed={allCollapsed}
          data-testid="collapse-all-btn"
        >
          {allCollapsed ? '▾ Alle ausklappen' : '▸ Alle einklappen'}
        </button>
      )}

      {/* AC6 (board-storys-archivieren): „Erledigte Storys archivieren" —
          deaktiviert wenn keine Story archivierbar ist; sonst öffnet ein Klick
          die Bestätigungsabfrage. Echter <button> mit sprechendem aria-label,
          Bedeutung nicht allein über Farbe (Text). */}
      {onArchiveDone && (
        <button
          ref={archiveTriggerRef}
          type="button"
          style={styles.archiveDoneBtn}
          disabled={!hasArchivable}
          onClick={handleOpenArchiveConfirm}
          aria-label={hasArchivable
            ? `Erledigte Storys archivieren: ${archivableStoryCount} ${archivableStoryCount === 1 ? 'Story' : 'Storys'}`
            : 'Erledigte Storys archivieren — keine erledigten Storys vorhanden'}
          title={hasArchivable ? undefined : 'Keine erledigten Storys'}
          data-testid="archive-done-btn"
        >
          Erledigte Storys archivieren
        </button>
      )}

      {/* AC6/AC7 (board-feature-archive): „Archiv anzeigen"-Schalter — echter
          Toggle-Button (aria-pressed), Default aus. Umschalten lädt die Board-
          Daten mit includeArchived neu; archivierte Features werden read-only +
          per Text klar markiert eingeblendet. Zustand nicht allein über Farbe:
          Text „Archiv anzeigen" + ☑/☐-Glyphe + aria-pressed. */}
      {onToggleArchived && (
        <button
          type="button"
          style={styles.archiveToggleBtn}
          onClick={onToggleArchived}
          aria-pressed={showArchived}
          aria-label={showArchived
            ? 'Archivierte Features ausblenden'
            : 'Archivierte Features anzeigen'}
          data-testid="archive-toggle-btn"
        >
          <span aria-hidden="true">{showArchived ? '☑' : '☐'}</span> Archiv anzeigen
        </button>
      )}

      {/* AC8/AC9/AC10 (bereichs-modell, S-290): „Bereiche verwalten" — nur
          sichtbar, sobald ein konkretes Projekt geladen ist (die Bereichsliste
          ist projekt-gebunden). Öffnet das modale AreasManageDialog. */}
      {projectSlug && (
        <button
          ref={areasTriggerRef}
          type="button"
          style={styles.areasManageBtn}
          onClick={handleOpenAreasManage}
          aria-label="Bereiche verwalten"
          data-testid="areas-manage-btn"
        >
          Bereiche verwalten
        </button>
      )}

      {/* AC6/AC8: Bestätigungsabfrage (fokussiertes Dialog-Muster). */}
      {archiveConfirmOpen && (
        <ArchiveConfirmDialog
          storyCount={archivableStoryCount}
          state={archiveState}
          error={archiveError}
          onCancel={handleCancelArchive}
          onConfirm={handleConfirmArchive}
        />
      )}

      {/* AC8/AC9/AC10 (bereichs-modell, S-290): „Bereiche verwalten"-Dialog. */}
      {areasManageOpen && projectSlug && (
        <AreasManageDialog
          projectSlug={projectSlug}
          onClose={handleCloseAreasManage}
          triggerRef={areasTriggerRef}
        />
      )}
    </div>
  );
}

// ── ArchiveConfirmDialog (board-storys-archivieren AC6/AC8) ───────────────────

/**
 * Bestätigungsabfrage für „Erledigte Storys archivieren" (V4, S-294 — löst die
 * frühere Feature-Ebenen-Fassung aus board-feature-archive V5/AC5 ab).
 *
 * AC6: nennt die Anzahl betroffener Storys + Hinweis, dass die Bereichs-
 *   Kacheln sichtbar bleiben; Abbrechen ändert nichts; Bestätigen ruft
 *   `onConfirm`; ein Endpoint-Fehler wird nicht-blockierend (role=alert) im
 *   Dialog gezeigt, ohne die Ansicht zu zerstören.
 * AC8: fokussiertes Dialog-Muster — `role="dialog"`, `aria-modal`,
 *   `aria-labelledby`; Fokus beim Öffnen auf das erste Bedienelement;
 *   Fokusfalle (Tab/Shift+Tab zyklisch); Esc bricht ab (außer während des
 *   laufenden POST); sichtbarer Fokusring (kein outline:none); Bedeutung nicht
 *   allein über Farbe (Text).
 *
 * @param {{
 *   storyCount: number,
 *   state: 'idle'|'submitting'|'error',
 *   error?: string,
 *   onCancel: () => void,
 *   onConfirm: () => void,
 * }} props
 */
function ArchiveConfirmDialog({ storyCount, state, error, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const titleId = 'archive-confirm-title';
  const submitting = state === 'submitting';

  // Fokus beim Öffnen + Esc-Abbruch + Fokusfalle (AC7).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('button:not([disabled])');
    if (focusable.length > 0) focusable[0].focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        if (!submitting) onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const items = dialog.querySelectorAll('button:not([disabled])');
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    dialog.addEventListener('keydown', handleKeyDown);
    return () => dialog.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, submitting]);

  const storyWord = storyCount === 1 ? 'Story' : 'Storys';
  const verb      = storyCount === 1 ? 'wird' : 'werden';

  return (
    <>
      {/* Backdrop — Board bleibt dahinter sichtbar; Klick bricht ab (nicht
          während des laufenden POST). */}
      <div
        style={styles.archiveBackdrop}
        onClick={submitting ? undefined : onCancel}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={styles.archiveDialog}
        data-testid="archive-confirm-dialog"
      >
        <h2 id={titleId} style={styles.archiveHeading}>Erledigte Storys archivieren</h2>
        <p style={styles.archiveBody} data-testid="archive-confirm-summary">
          {storyCount} erledigte {storyWord} {verb} archiviert.
          Sie verschwinden aus der Übersicht, bleiben aber gespeichert.
          Die Bereichs-Kacheln bleiben sichtbar.
        </p>

        {state === 'error' && error && (
          <div role="alert" style={styles.archiveError} data-testid="archive-confirm-error">
            {error}
          </div>
        )}

        <div style={styles.archiveActions}>
          <button
            type="button"
            style={styles.archiveCancelBtn}
            onClick={onCancel}
            disabled={submitting}
            aria-label="Archivieren abbrechen"
            data-testid="archive-cancel-btn"
          >
            Abbrechen
          </button>
          <button
            type="button"
            style={styles.archiveConfirmBtn}
            onClick={onConfirm}
            disabled={submitting}
            aria-busy={submitting}
            aria-label="Archivieren bestätigen"
            data-testid="archive-confirm-btn"
          >
            {submitting ? 'Archiviere…' : 'Bestätigen'}
          </button>
        </div>
      </div>
    </>
  );
}

// ── ProjectListItem ───────────────────────────────────────────────────────────

/**
 * One row in the standalone project list (AC6).
 * Shows slug + coarse counters; click loads the project.
 *
 * @param {{
 *   item: { slug: string, feature_count?: number, story_count?: number, error?: string },
 *   onSelect: (slug: string) => void
 * }} props
 */
function ProjectListItem({ item, onSelect }) {
  return (
    <div
      role="listitem"
      style={styles.projectListItem}
      data-project-list-item={item.slug}
    >
      {item.error ? (
        <div style={styles.projectListItemContent}>
          <span style={styles.projectListSlug}>{item.slug}</span>
          <span style={styles.errorBadge} role="status" aria-label="Fehler">
            Fehler: {item.error}
          </span>
        </div>
      ) : (
        <div style={styles.projectListItemContent}>
          <button
            type="button"
            style={styles.projectListBtn}
            onClick={() => onSelect(item.slug)}
            aria-label={`Projekt ${item.slug} öffnen`}
            data-testid={`project-select-${item.slug}`}
          >
            {item.slug}
          </button>
          <span style={styles.projectListMeta} aria-label="Zähler">
            {item.feature_count ?? 0} Features · {item.story_count ?? 0} Stories
          </span>
        </div>
      )}
    </div>
  );
}

// ── ProjectSection ────────────────────────────────────────────────────────────

/**
 * One project block: header + list of features (AC4).
 * If the project has an error, renders an error badge (AC8).
 *
 * @param {{
 *   project: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   collapsedIds?: Set<string>,
 *   onCollapseToggle?: (featureId: string) => void,
 *   hasRestrictingFilter?: boolean,
 *   specifyJobs?: object,
 * }} props
 */
function ProjectSection({ project, onOpenSpec, onStoryClick, onSpecifyIdea, collapsedIds, onCollapseToggle, hasRestrictingFilter, specifyJobs }) {
  const slug = project.slug || project.project_slug || project.repo_path || '?';

  return (
    <section
      role="listitem"
      style={styles.projectSection}
      aria-label={`Projekt: ${slug}`}
      data-project={slug}
    >
      {/* Project header */}
      <div style={styles.projectHeader}>
        <h2 style={styles.projectTitle}>{slug}</h2>
        {project.error && (
          <span style={styles.errorBadge} role="status" aria-label="Fehler">
            Fehler: {project.error}
          </span>
        )}
        {project.repo_path && (
          <span style={styles.repoBadge} aria-label="Repo-Pfad">
            {project.repo_path}
          </span>
        )}
      </div>

      {/* run-state-live-view AC7/AC8/AC10: aktive Feature-Läufe kompakt anzeigen —
          leer/unauffällig, wenn kein Lauf aktiv ist (kein Platzhalter-Rauschen).
          Aktualisiert sich über denselben SSE-Re-Fetch wie der Rest des Projekts
          (AC8) — kein eigener EventSource, kein eigenes Polling. */}
      {!project.error && <RunsSummary runs={project.runs} />}

      {/* Features */}
      {!project.error && (project.features ?? []).length === 0 && (
        <p style={styles.hintMsg}>Keine Features in diesem Projekt.</p>
      )}

      {!project.error && (project.features ?? []).map((feature) => (
        <FeatureRow
          key={feature.id}
          feature={feature}
          projectSlug={slug}
          onOpenSpec={onOpenSpec}
          onStoryClick={onStoryClick}
          onSpecifyIdea={onSpecifyIdea}
          isCollapsed={collapsedIds ? collapsedIds.has(feature.id) : false}
          onCollapseToggle={onCollapseToggle}
          hasRestrictingFilter={hasRestrictingFilter ?? false}
          specifyJobs={specifyJobs}
        />
      ))}
    </section>
  );
}

// ── RunsSummary (run-state-live-view AC7/AC8) ─────────────────────────────────

/** Phasen-Label, textlich (nie nur über Farbe/Icon — AC7). */
const RUN_PHASE_LABELS = {
  dossier: 'Dossier',
  story: 'Story',
  merge: 'Merge',
  rollout: 'Rollout',
};

/**
 * Kompakte Anzeige der aktiven Feature-Läufe eines Projekts (run-state-live-view
 * AC7): Feature-ID, Phase, aktuelle Story, Fortschritt (done/total) und —
 * falls gesetzt — der letzte Fehler. Kein aktiver Lauf → nichts gerendert
 * (leer/unauffällig, kein Platzhalter-Rauschen). Dossier/Notizen werden NICHT
 * gerendert (Nicht-Ziel, AC8/AC10).
 *
 * @param {{ runs?: Array<object> }} props
 */
function RunsSummary({ runs }) {
  const activeRuns = (runs ?? []).filter((r) => !r.isLastRun);
  if (activeRuns.length === 0) return null;

  return (
    <div style={styles.runsSummary} role="list" aria-label="Aktive Feature-Läufe">
      {activeRuns.map((run) => {
        const phaseLabel = run.phase ? (RUN_PHASE_LABELS[run.phase] ?? run.phase) : 'Unbekannt';
        const progressLabel =
          run.done != null && run.total != null ? `${run.done}/${run.total}` : null;
        return (
          <div
            key={run.feature}
            role="listitem"
            style={styles.runsSummaryItem}
            data-testid={`run-summary-${run.feature}`}
          >
            <span style={styles.runsSummaryFeature}>{run.feature}</span>
            <span style={styles.runsSummaryPhase}>Phase: {phaseLabel}</span>
            {run.currentStory && (
              <span style={styles.runsSummaryDetail}>Story: {run.currentStory}</span>
            )}
            {progressLabel && (
              <span style={styles.runsSummaryDetail}>Fortschritt: {progressLabel}</span>
            )}
            {run.lastError && (
              <span style={styles.runsSummaryError} role="status" aria-label="Letzter Fehler">
                Fehler: {run.lastError}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── FeatureRow ────────────────────────────────────────────────────────────────

/**
 * One feature row: collapse-button (AC1/AC7), title, rollup bar (AC5),
 * detail-button (AC2), then stories in status columns (AC4).
 *
 * AC1: Auf-/Zu-Schalter (Collapse-Button) blendet Story-Spalten aus.
 * AC2: Detail-Panel (Ziel/DoD) über separaten Schalter; bei eingeklappt verborgen.
 * AC6: Filter-Wechselwirkung — temporär ausgeklappt wenn Treffer vorhanden + Filter aktiv.
 * AC7: aria-expanded + aria-controls, Fokusring erhalten, Chevron aria-hidden.
 *
 * @param {{
 *   feature: object,
 *   projectSlug?: string,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   isCollapsed?: boolean,
 *   onCollapseToggle?: (featureId: string) => void,
 *   hasRestrictingFilter?: boolean,
 *   specifyJobs?: object,
 * }} props
 */
function FeatureRow({ feature, projectSlug, onOpenSpec, onStoryClick, onSpecifyIdea, isCollapsed = false, onCollapseToggle, hasRestrictingFilter = false, specifyJobs }) {
  // AC2: separate detail-panel open/close state (entkoppelt vom Einklappen)
  const [detailOpen, setDetailOpen] = useState(false);
  const rollup = computeRollup(feature);
  // board-feature-archive AC6/V6: archivierte Features werden read-only + klar
  // per Text „Archiviert" markiert eingeblendet (nur wenn der „Archiv anzeigen"-
  // Schalter an ist, liefert das Backend sie via includeArchived überhaupt aus).
  const isArchivedFeature = feature.archived === true;
  // stories prop contains FILTERED stories (from filteredProjects — only matching filter)
  const stories = Array.isArray(feature.stories) ? feature.stories : [];

  // AC6: Wenn Filter aktiv UND Feature hat passende Stories → temporär ausgeklappt anzeigen.
  // Diese Aufklappung überschreibt isCollapsed NUR für die Anzeige, nie den gespeicherten Zustand.
  const hasFilteredStories = hasRestrictingFilter && stories.length > 0;
  // Effective collapsed: eingeklappt wenn isCollapsed UND (kein Filter ODER keine Treffer)
  const effectivelyCollapsed = isCollapsed && !hasFilteredStories;

  // Group stories by status column (AC4)
  const byStatus = {};
  for (const s of STATUS_LIFECYCLE) {
    byStatus[s] = [];
  }
  for (const story of stories) {
    const key = story.status && byStatus[story.status] !== undefined
      ? story.status
      : null;
    if (key) {
      byStatus[key].push(story);
    } else {
      // Stories with unknown status go to 'To Do' bucket
      byStatus['To Do'].push(story);
    }
  }

  const handleCollapseClick = useCallback(() => {
    if (onCollapseToggle) onCollapseToggle(feature.id);
  }, [feature.id, onCollapseToggle]);

  const handleDetailClick = useCallback(() => {
    setDetailOpen((prev) => !prev);
  }, []);

  const storiesRegionId = `feature-stories-${feature.id}`;
  const detailRegionId  = `feature-detail-${feature.id}`;

  return (
    <div
      style={isArchivedFeature ? { ...styles.featureRow, ...styles.featureRowArchived } : styles.featureRow}
      data-feature={feature.id}
      data-archived={isArchivedFeature ? 'true' : undefined}
      aria-label={isArchivedFeature
        ? `Feature (archiviert, schreibgeschützt): ${feature.title || feature.id}`
        : `Feature: ${feature.title || feature.id}`}
    >
      {/* Feature header */}
      <div style={styles.featureHeader}>
        {/* AC1/AC7: Collapse-Button — blendet Story-Spalten aus/ein */}
        <button
          type="button"
          style={styles.featureCollapseBtn}
          onClick={handleCollapseClick}
          aria-expanded={!effectivelyCollapsed}
          aria-controls={storiesRegionId}
          aria-label={effectivelyCollapsed
            ? `Feature ${feature.title || feature.id} ausklappen`
            : `Feature ${feature.title || feature.id} einklappen`}
          data-testid={`feature-collapse-btn-${feature.id}`}
        >
          {/* Chevron aria-hidden (AC7) */}
          <span style={styles.featureTitleChevron} aria-hidden="true">
            {effectivelyCollapsed ? '▸' : '▾'}
          </span>
          {feature.title || feature.id}
        </button>

        {feature.status && (
          <StatusBadge status={feature.status} />
        )}
        {/* AC6/AC7 (board-feature-archive): „Archiviert"-Badge — Bedeutung per
            Text (nicht nur Farbe), sprechendes aria-label. */}
        {isArchivedFeature && (
          <span
            style={styles.archivedBadge}
            aria-label="Archiviert (schreibgeschützt)"
            data-testid={`archived-badge-${feature.id}`}
          >
            Archiviert
          </span>
        )}
        {/* feature-umsetzen-button D1/D2: nach StatusBadge/Archiviert-Badge, vor RollupBar;
            kein Button bei archiviert oder 0 Storys (design.md Abschnitt 1). Owner-Entscheidung
            2026-07-06 (zweite Korrektur): der Button erscheint unabhängig von der Story-Anzahl —
            1 Story oder 30, immer klickbar, kein Ablehnungs-Check. */}
        {!isArchivedFeature && rollup.total > 0 && (
          <FeatureBatchButton feature={feature} projectSlug={projectSlug} />
        )}

        {/* Rollup bar (AC5) */}
        <RollupBar done={rollup.done} total={rollup.total} />

        {/* AC2: Separater Details-Schalter (Ziel/DoD) — nur sichtbar wenn ausgeklappt */}
        {!effectivelyCollapsed && (
          <button
            type="button"
            style={styles.featureTitleBtn}
            onClick={handleDetailClick}
            aria-expanded={detailOpen}
            aria-controls={detailOpen ? detailRegionId : undefined}
            data-testid={`feature-title-btn-${feature.id}`}
            aria-label={`Details für Feature ${feature.title || feature.id} ${detailOpen ? 'schließen' : 'öffnen'}`}
          >
            <span aria-hidden="true">{detailOpen ? 'ⓘ ▾' : 'ⓘ ▸'}</span>
          </button>
        )}
      </div>

      {/* AC2: Feature detail panel — shown when detail expanded AND feature not collapsed */}
      {!effectivelyCollapsed && detailOpen && (
        <div
          id={detailRegionId}
          style={styles.featureDetail}
          data-testid={`feature-detail-${feature.id}`}
          aria-label={`Details für Feature: ${feature.title || feature.id}`}
        >
          <FeatureDetailPanel feature={feature} />
        </div>
      )}

      {/* AC1: Stories region — hidden when collapsed */}
      {!effectivelyCollapsed && (
        <div id={storiesRegionId}>
          {/* Status columns (AC4) */}
          {stories.length > 0 && (
            <div style={styles.statusColumns} role="list" aria-label="Stories nach Status">
              {STATUS_LIFECYCLE.map((status) => (
                <StatusColumn
                  key={status}
                  status={status}
                  stories={byStatus[status]}
                  onOpenSpec={onOpenSpec}
                  onStoryClick={onStoryClick}
                  onSpecifyIdea={onSpecifyIdea}
                  specifyJobs={specifyJobs}
                />
              ))}
            </div>
          )}

          {stories.length === 0 && (
            <p style={styles.hintMsg}>Keine Stories in diesem Feature.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── FeatureDetailPanel ────────────────────────────────────────────────────────

/**
 * Detail panel for a feature — shows goal, definition_of_done, priority, depends, labels.
 * Fields that are null/empty are omitted (dezent ausgeblendet).
 *
 * @param {{ feature: object }} props
 */
function FeatureDetailPanel({ feature }) {
  const hasLabels = Array.isArray(feature.labels) && feature.labels.length > 0;
  const hasDepends = Array.isArray(feature.depends) && feature.depends.length > 0;

  return (
    <dl style={styles.detailDl}>
      {feature.goal && (
        <>
          <dt style={styles.detailTerm}>Ziel</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-goal">{feature.goal}</dd>
        </>
      )}
      {feature.definition_of_done && (
        <>
          <dt style={styles.detailTerm}>Definition of Done</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-dod">{feature.definition_of_done}</dd>
        </>
      )}
      {feature.priority && (
        <>
          <dt style={styles.detailTerm}>Priorität</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-priority">{feature.priority}</dd>
        </>
      )}
      {hasDepends && (
        <>
          <dt style={styles.detailTerm}>Abhängigkeiten</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-depends">
            <div style={styles.labelRow}>
              {feature.depends.map((dep) => (
                <span key={dep} style={styles.dependsChip}>{dep}</span>
              ))}
            </div>
          </dd>
        </>
      )}
      {hasLabels && (
        <>
          <dt style={styles.detailTerm}>Labels</dt>
          <dd style={styles.detailDesc} data-testid="feature-detail-labels">
            <div style={styles.labelRow}>
              {feature.labels.map((lbl) => (
                <span key={lbl} style={styles.labelChip} aria-label={`Label: ${lbl}`}>{lbl}</span>
              ))}
            </div>
          </dd>
        </>
      )}
    </dl>
  );
}

// ── RollupBar ─────────────────────────────────────────────────────────────────

/**
 * Progress/rollup bar for a feature (AC5).
 * Shows "done/total done" as text and a visual bar.
 *
 * @param {{ done: number, total: number }} props
 */
function RollupBar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const label = `${done}/${total} done`;

  return (
    <div
      style={styles.rollupContainer}
      aria-label={`Fortschritt: ${label}`}
      data-testid="rollup-bar"
    >
      <span style={styles.rollupText}>{label}</span>
      <div
        style={styles.rollupTrack}
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}%`}
      >
        <div
          style={{
            ...styles.rollupFill,
            width: `${pct}%`,
          }}
        />
      </div>
    </div>
  );
}

// ── StatusColumn ──────────────────────────────────────────────────────────────

/**
 * One status column with a header label and list of StoryCards.
 * Always rendered (even when empty) so the grid is consistent (AC4).
 *
 * @param {{
 *   status: string,
 *   stories: object[],
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   specifyJobs?: object,
 * }} props
 */
function StatusColumn({ status, stories, onOpenSpec, onStoryClick, onSpecifyIdea, specifyJobs }) {
  return (
    <div
      role="listitem"
      style={styles.statusColumn}
      aria-label={`Status: ${status}`}
      data-status={status}
    >
      <div style={styles.columnHeader}>
        <StatusBadge status={status} />
        {stories.length > 0 && (
          <span style={styles.columnCount} aria-label={`${stories.length} Stories`}>
            {stories.length}
          </span>
        )}
      </div>

      {stories.map((story) => (
        <StoryCard
          key={story.id}
          story={story}
          onOpenSpec={onOpenSpec}
          onStoryClick={onStoryClick}
          onSpecifyIdea={onSpecifyIdea}
          specifyJob={specifyJobs ? specifyJobs[story.id] : undefined}
        />
      ))}
    </div>
  );
}

// ── StoryCard ─────────────────────────────────────────────────────────────────

/**
 * Story card: id, title, priority, labels, spec link (AC3 model fields).
 * AC5 — Spec-Bezug ist klickbar (wenn onOpenSpec vorhanden): öffnet Spec im
 *        Spezifikation-Reiter. story.spec enthält den relativen Pfad (z.B. docs/specs/foo.md).
 * AC3 (story-detail-ansicht) — Karte als Button klickbar wenn onStoryClick vorhanden.
 * AC4 (autonome-board-abarbeitung) — Ready-Badge für To-Do-Stories; blocked_reason als
 *        Hinweiszeile unter dem Titel für Blocked-Stories.
 *
 * idea-specify-chat AC1/AC2 (S-218) — für `status === 'Idee'` UND `onSpecifyIdea`
 * vorhanden zusätzlich ein kleiner „Spezifizieren"-Trigger NEBEN der (weiterhin
 * klickbaren, dasselbe Chat-Overlay öffnenden) Karte — additiv, kein
 * verschachteltes `<button>`-in-`<button>` (ungültiges HTML). Beide Auslöser
 * (Karte, Button) rufen dieselbe Handler-Signatur `(story, triggerEl)` auf.
 *
 * idea-specify-background-status AC3/AC4 (S-230) — für `status === 'Idee'` mit
 * einem laufenden bzw. fehlgeschlagenen Finalize-Job (`specifyJob`) rendert die
 * Karte einen sichtbaren, nicht nur farblichen Lauf-/Fehler-Indikator
 * (Text + Icon + `aria-busy`/`role=status`/`aria-live`). Bei `done` liefert der
 * Endpunkt keinen Job mehr → kein Badge.
 *
 * @param {{
 *   story: object,
 *   onOpenSpec?: (relPath: string) => void,
 *   onStoryClick?: (story: object) => void,
 *   onSpecifyIdea?: (story: object, triggerEl: HTMLElement) => void,
 *   specifyJob?: { status: 'running'|'failed'|'auth-expired', jobId: string, error?: string },
 * }} props
 */
function StoryCard({ story, onOpenSpec, onStoryClick, onSpecifyIdea, specifyJob }) {
  // AC12 — derive entity reference from story labels for icon display.
  const entityRef = parseEntityLabel(story.labels ?? []);

  // idea-specify-background-status AC3/AC4 (S-230): Lauf-/Fehler-Indikator nur an
  // Idee-Karten mit bekanntem Finalize-Job. `done` ist im Endpunkt entfernt →
  // kein Badge (Karte übernommen/archiviert).
  const isIdea = story.status === 'Idee';
  const specifyRunning = isIdea && specifyJob?.status === 'running';
  const specifyFailed  = isIdea && (specifyJob?.status === 'failed' || specifyJob?.status === 'auth-expired');

  // board-feature-archive AC6/V6: archivierte Stories werden read-only + klar
  // per Text „Archiviert" markiert dargestellt und tragen KEINE Klick-/Aktions-
  // Affordance (kein Karten-Button, kein Spezifizieren). Deckt auch den Randfall
  // einer einzeln archivierten Story (deren Feature sichtbar bliebe) ab.
  const isArchived = story.archived === true;

  const cardContent = (
    <>
      {/* AC6/AC7: „Archiviert"-Marker — Bedeutung per Text (nicht nur Farbe). */}
      {isArchived && (
        <p
          style={styles.storyArchivedMarker}
          aria-label="Archiviert (schreibgeschützt)"
          data-testid={`story-archived-${story.id}`}
        >
          Archiviert
        </p>
      )}
      <div style={styles.storyHeader}>
        {entityRef && (
          <EntityIcon kind={entityRef.kind} id={entityRef.id} size={14} />
        )}
        <span style={styles.storyId} aria-label="Story-ID">{story.id}</span>
        {story.priority && (
          <span style={styles.priorityBadge} aria-label={`Priorität: ${story.priority}`}>
            {story.priority}
          </span>
        )}
        {/* AC4: Ready-Badge for To-Do stories */}
        {story.status === 'To Do' && story.ready === true && (
          <span
            style={styles.readyBadge}
            aria-label="Story ist ready für autonome Abarbeitung"
            title="Ready — alle Voraussetzungen erfüllt"
            data-testid={`ready-badge-${story.id}`}
          >
            ready
          </span>
        )}
      </div>

      {story.title && (
        <p style={styles.storyTitle}>{story.title}</p>
      )}

      {/* AC3 (idea-specify-background-status): Lauf-Indikator „wird spezifiziert…"
          solange ein Finalize-Job für diese Idee `running` ist — nicht nur
          farblich (Text + Icon + aria-busy/role=status/aria-live). */}
      {specifyRunning && (
        <p
          style={styles.specifyRunningBadge}
          role="status"
          aria-live="polite"
          aria-busy="true"
          data-testid={`specify-running-badge-${story.id}`}
        >
          <span style={styles.specifySpinner} aria-hidden="true">⟳</span>
          wird spezifiziert…
        </p>
      )}

      {/* AC4 (idea-specify-background-status): nicht-blockierender, secret-freier
          Fehler-Hinweis bei failed/auth-expired; die Karte bleibt anklickbar
          (Retry via Overlay-Reopen). */}
      {specifyFailed && (
        <p
          style={styles.specifyErrorBadge}
          role="status"
          aria-live="polite"
          data-testid={`specify-error-badge-${story.id}`}
        >
          <span aria-hidden="true">⚠ </span>
          Spezifizieren fehlgeschlagen — erneut versuchen
        </p>
      )}

      {/* AC4: blocked_reason hint for Blocked stories */}
      {story.status === 'Blocked' && story.blocked_reason && (
        <p
          style={styles.blockedReason}
          aria-label={`Grund: ${story.blocked_reason}`}
          title={story.blocked_reason}
          data-testid={`blocked-reason-${story.id}`}
        >
          {story.blocked_reason}
        </p>
      )}

      {/* Labels (AC6 — filter target) */}
      {(story.labels ?? []).length > 0 && (
        <div style={styles.labelRow} aria-label="Labels">
          {story.labels.map((lbl) => (
            <span key={lbl} style={styles.labelChip} aria-label={`Label: ${lbl}`}>
              {lbl}
            </span>
          ))}
        </div>
      )}

      {/* Spec reference (AC5 — klickbar wenn onOpenSpec vorhanden) */}
      {story.spec && (
        <div style={styles.specRef} aria-label="Spec">
          <span style={styles.specLabel}>Spec: </span>
          {onOpenSpec ? (
            <button
              type="button"
              style={styles.specLink}
              onClick={(e) => { e.stopPropagation(); onOpenSpec(story.spec); }}
              aria-label={`Spec öffnen: ${story.spec}`}
              data-testid={`spec-link-${story.id}`}
            >
              {story.spec}
            </button>
          ) : (
            <span style={styles.specValue}>{story.spec}</span>
          )}
        </div>
      )}
    </>
  );

  // AC3 (story-detail-ansicht): when onStoryClick is provided, wrap the card in a button.
  // idea-specify-chat AC1 (S-218): for status === 'Idee', the click opens the
  // Spezifizieren-Chat-Overlay instead of the detail view — reflected in the
  // aria-label for screen-reader clarity.
  // board-feature-archive AC6/V6: archivierte Stories bekommen KEINE Klick-/
  // Aktions-Affordance — sie fallen auf die read-only <article>-Darstellung durch.
  if (onStoryClick && !isArchived) {
    const cardButton = (
      <button
        type="button"
        style={{ ...styles.storyCard, ...styles.storyCardBtn }}
        aria-label={isIdea ? `Idee spezifizieren: ${story.title || story.id}` : `Story: ${story.title || story.id}`}
        data-story={story.id}
        onClick={(e) => onStoryClick(story, e.currentTarget)}
        data-testid={`story-card-btn-${story.id}`}
      >
        {cardContent}
      </button>
    );

    // idea-specify-chat AC2 (S-218): additiver „Spezifizieren"-Trigger NEBEN
    // der Karte (kein <button> in <button>) — gleiches Overlay wie der Karte-Klick.
    if (isIdea && onSpecifyIdea) {
      return (
        <div style={styles.ideaCardWrapper} data-testid={`idea-card-wrapper-${story.id}`}>
          {cardButton}
          <button
            type="button"
            style={styles.ideaSpecifyBtn}
            onClick={(e) => onSpecifyIdea(story, e.currentTarget)}
            aria-label={`Spezifizieren: ${story.title || story.id}`}
            data-testid={`idea-specify-btn-${story.id}`}
          >
            Spezifizieren
          </button>
        </div>
      );
    }

    return cardButton;
  }

  return (
    <article
      style={isArchived ? { ...styles.storyCard, ...styles.storyCardArchived } : styles.storyCard}
      aria-label={isArchived
        ? `Story (archiviert, schreibgeschützt): ${story.title || story.id}`
        : `Story: ${story.title || story.id}`}
      data-story={story.id}
      data-archived={isArchived ? 'true' : undefined}
    >
      {cardContent}
    </article>
  );
}

// ── StoryDetailView ───────────────────────────────────────────────────────────

/**
 * Story-Detail-Ansicht (AC3/AC4 story-detail-ansicht; AC5/AC6 story-detail-yaml-fallback).
 *
 * Blöcke:
 *   (1) Zeiten       — Start / Ende (auch aus YAML) / Dauer
 *   (2) Agenten-Flow — chronologisch; differenzierter Leer-Zustand (AC5 yaml-fallback)
 *   (3) Soll-Ist     — ep_est↔ep_act, tok_est↔tok_total, Abweichung %
 *   (4) Verknüpfungen — Branch + PR-Link (AC6 yaml-fallback); ausgeblendet wenn beide null
 *
 * Rückweg zum Board per onBack (AC3 Rückweg vorhanden).
 * Touch-Targets ≥ 44 px (WCAG 2.1 AA).
 * Kein dangerouslySetInnerHTML; externer PR-Link rel=noopener noreferrer (AC8 Floor).
 *
 * @param {{
 *   story: { slug: string, storyId: string, storyTitle: string },
 *   detailState: 'idle'|'loading'|'ok'|'error',
 *   detailData: object|null,
 *   detailError: string,
 *   onBack: () => void,
 * }} props
 */
function StoryDetailView({ story, detailState, detailData, detailError, onBack }) {
  /**
   * Format ISO timestamp to readable locale string (no dangerouslySetInnerHTML).
   * Returns '—' when ts is null/invalid.
   */
  function fmtTs(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  /**
   * Format duration (seconds) to readable string.
   */
  function fmtDuration(secs) {
    if (secs == null) return '—';
    const s = Math.round(secs);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m} min ${rem} s` : `${m} min`;
  }

  /**
   * Format a numeric value with a fallback.
   */
  function fmtNum(v, fallback = '—') {
    return v != null ? String(v) : fallback;
  }

  // Token-Feld eines Dispatch-Schritts: im Ledger ein Objekt {in, out, cache}
  // (nicht eine Zahl). Zelle = Summe in+out+cache — dieselbe Definition wie
  // tok_total; die Aufschlüsselung kommt als title-Tooltip mit. null → '—'.
  function fmtTok(tok, fallback = '—') {
    if (tok == null) return { text: fallback, title: undefined };
    if (typeof tok === 'number') return { text: String(tok), title: undefined };
    if (typeof tok === 'object') {
      const i = tok.in ?? 0;
      const o = tok.out ?? 0;
      const c = tok.cache ?? 0;
      return {
        text: String(i + o + c),
        title: `in ${i} · out ${o} · cache ${c}`,
      };
    }
    return { text: fallback, title: undefined };
  }

  /**
   * Format deviation percentage with sign.
   */
  function fmtDevPct(pct) {
    if (pct == null) return '—';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct}%`;
  }

  return (
    <main style={styles.main} aria-label={`Story-Detail: ${story.storyTitle}`}>
      {/* ── Back button (AC3 — Rückweg vorhanden) ──────────────────────────── */}
      <button
        type="button"
        style={styles.backBtn}
        onClick={onBack}
        aria-label="Zurück zum Board"
        data-testid="detail-back-btn"
      >
        ← Board
      </button>

      <h1 style={styles.h1}>{story.storyId}: {story.storyTitle}</h1>

      {/* Loading */}
      {detailState === 'loading' && (
        <div aria-busy="true" aria-live="polite" style={styles.statusMsg}
          data-testid="detail-loading">
          Lade Story-Details…
        </div>
      )}

      {/* Error */}
      {detailState === 'error' && (
        <div role="alert" style={styles.errorMsg} data-testid="detail-error">
          Fehler beim Laden der Story-Details: {detailError}
        </div>
      )}

      {/* Detail blocks (AC3/AC4) */}
      {detailState === 'ok' && detailData != null && (
        <div style={styles.detailBlocks} data-testid="detail-blocks">

          {/* ── Block 1: Zeiten (AC3; AC5 yaml-fallback — Ende aus YAML mit Badge) ── */}
          <section style={styles.detailBlock} aria-label="Zeiten" data-testid="block-zeiten">
            <h2 style={styles.detailBlockTitle}>Zeiten</h2>
            <dl style={styles.detailDl}>
              <dt style={styles.detailTerm}>Start</dt>
              <dd style={styles.detailDesc} data-testid="detail-started-at">
                {fmtTs(detailData.started_at)}
              </dd>
              <dt style={styles.detailTerm}>Ende</dt>
              <dd style={styles.detailDesc} data-testid="detail-ended-at">
                {detailData.ended_at != null ? (
                  <>
                    {fmtTs(detailData.ended_at)}
                    {detailData.ended_at_source === 'yaml' && (
                      <span
                        style={styles.yamlBadge}
                        aria-label="Ende-Zeit aus Board-YAML (done_at)"
                        title="Ende-Zeit aus Board-YAML — kein Ledger-Eintrag"
                        data-testid="ended-at-yaml-badge"
                      >
                        YAML
                      </span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt style={styles.detailTerm}>Dauer</dt>
              <dd style={styles.detailDesc} data-testid="detail-duration">
                {fmtDuration(detailData.duration)}
              </dd>
            </dl>
          </section>

          {/* ── Block 2: Agenten-Flow (AC3; AC5 yaml-fallback — differenz. Leer-Zustand) ── */}
          <section style={styles.detailBlock} aria-label="Agenten-Flow" data-testid="block-flow">
            <h2 style={styles.detailBlockTitle}>Agenten-Flow</h2>
            {(!detailData.flow || detailData.flow.length === 0) ? (
              <p style={styles.hintMsg} data-testid="flow-empty">
                {/* AC3b: ehrlicher Leer-Zustand — benennt die tatsächliche Ursache,
                    unterscheidet fehlendes Ledger von fehlender Story-Zeile. */}
                {detailData.ledger_present === false
                  ? 'In diesem Projekt wird (noch) keine Metrik erfasst — kein Ledger vorhanden.'
                  : detailData.ended_at != null
                    ? 'Diese Story wurde ohne Metrik-Erfassung abgeschlossen — kein Agenten-Flow aufgezeichnet.'
                    : 'Noch kein Flow-Lauf erfasst.'}
              </p>
            ) : (
              <table style={styles.flowTable} aria-label="Agenten-Flow-Schritte">
                <thead>
                  <tr>
                    <th style={styles.flowTh}>Seq</th>
                    <th style={styles.flowTh}>Agent</th>
                    <th style={styles.flowTh}>Iter.</th>
                    <th style={styles.flowTh}>Gate</th>
                    <th style={styles.flowTh}>Dauer</th>
                    <th style={styles.flowTh}>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {detailData.flow.map((step, idx) => (
                    <tr key={idx} data-testid={`flow-step-${idx}`}>
                      <td style={styles.flowTd}>{fmtNum(step.seq)}</td>
                      <td style={styles.flowTd}>{step.agent ?? '—'}</td>
                      <td style={styles.flowTd}>{fmtNum(step.iter)}</td>
                      <td style={styles.flowTd}>{step.gate ?? '—'}</td>
                      <td style={styles.flowTd}>
                        {step.secs != null ? fmtDuration(step.secs) : '—'}
                      </td>
                      {(() => {
                        const t = fmtTok(step.tok);
                        return (
                          <td style={styles.flowTd} title={t.title} data-testid={`flow-tok-${idx}`}>
                            {t.text}
                          </td>
                        );
                      })()}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* ── Block 3: Soll-Ist (AC3/AC4) ────────────────────────────────── */}
          <section style={styles.detailBlock} aria-label="Soll-Ist" data-testid="block-soll-ist">
            <h2 style={styles.detailBlockTitle}>Soll-Ist</h2>
            <table style={styles.flowTable} aria-label="Soll-Ist-Vergleich">
              <thead>
                <tr>
                  <th style={styles.flowTh}>Metrik</th>
                  <th style={styles.flowTh}>Schätzung</th>
                  <th style={styles.flowTh}>Ist</th>
                  <th style={styles.flowTh}>Abweichung</th>
                </tr>
              </thead>
              <tbody>
                {/* Effort Points */}
                <tr data-testid="soll-ist-ep">
                  <td style={styles.flowTd}>Effort Points</td>
                  <td style={styles.flowTd} data-testid="ep-est">
                    {detailData.ep_est != null ? (
                      <>
                        {detailData.ep_est}
                        {detailData.ep_est_source === 'yaml' && (
                          <span
                            style={styles.vorabBadge}
                            aria-label="Vorab-Schätzung aus Story-YAML"
                            title="Vorab-Schätzung aus Story-YAML — noch kein Flow-Lauf"
                            data-testid="ep-est-vorab-badge"
                          >
                            Vorab
                          </span>
                        )}
                      </>
                    ) : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="ep-act">
                    {/* AC5: Ist-Spalte leer wenn YAML-Fallback (kein Ledger-Wert) */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtNum(detailData.ep_act)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.ep_dev_pct),
                  }} data-testid="ep-dev">
                    {/* AC5: Abweichung leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtDevPct(detailData.ep_dev_pct)}
                  </td>
                </tr>
                {/* Tokens */}
                <tr data-testid="soll-ist-tok">
                  <td style={styles.flowTd}>Tokens</td>
                  <td style={styles.flowTd} data-testid="tok-est">
                    {detailData.tok_est != null ? (
                      detailData.tok_est
                    ) : (
                      <span style={styles.noEstimate}>keine Schätzung</span>
                    )}
                  </td>
                  <td style={styles.flowTd} data-testid="tok-total">
                    {/* AC5: Ist-Spalte leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtNum(detailData.tok_total)}
                  </td>
                  <td style={{
                    ...styles.flowTd,
                    color: devColor(detailData.tok_dev_pct),
                  }} data-testid="tok-dev">
                    {/* AC5: Abweichung leer wenn YAML-Fallback */}
                    {detailData.ep_est_source === 'yaml' ? '—' : fmtDevPct(detailData.tok_dev_pct)}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* ── Block 4: Verknüpfungen (AC6 story-detail-yaml-fallback) ────────── */}
          {/* Block nur anzeigen wenn branch oder pr vorhanden (AC6: sonst ausblenden) */}
          {(detailData.branch != null || detailData.pr != null) && (
            <section
              style={styles.detailBlock}
              aria-label="Verknüpfungen"
              data-testid="block-verknuepfungen"
            >
              <h2 style={styles.detailBlockTitle}>Verknüpfungen</h2>
              <dl style={styles.detailDl}>
                {detailData.branch != null && (
                  <>
                    <dt style={styles.detailTerm}>Branch</dt>
                    <dd style={styles.detailDesc} data-testid="detail-branch">
                      <span style={styles.monoText}>{detailData.branch}</span>
                    </dd>
                  </>
                )}
                {detailData.pr != null && (
                  <>
                    <dt style={styles.detailTerm}>Pull Request</dt>
                    <dd style={styles.detailDesc} data-testid="detail-pr">
                      {/* AC8: externer Link mit rel=noopener noreferrer; kein dangerouslySetInnerHTML */}
                      <a
                        href={detailData.pr}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.prLink}
                        aria-label={`Pull Request öffnen: ${detailData.pr}`}
                      >
                        {detailData.pr}
                      </a>
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
        </div>
      )}

      {/* Loaded but no data (metrics missing) */}
      {detailState === 'ok' && detailData == null && (
        <div role="status" style={styles.statusMsg} data-testid="detail-no-data">
          Keine Metrik-Daten für diese Story vorhanden.
        </div>
      )}
    </main>
  );
}

/**
 * Color for deviation (positive = over-estimate → red, negative = under → green).
 * @param {number|null} pct
 * @returns {string}
 */
function devColor(pct) {
  if (pct == null) return '#9ca3af';
  if (pct > 0) return '#f87171'; // red: exceeded estimate
  if (pct < 0) return '#86efac'; // green: under estimate
  return '#9ca3af';
}

// ── StatusBadge ───────────────────────────────────────────────────────────────

/**
 * Badge with text label for a status value.
 * Meaning conveyed via text, not only colour (WCAG 2.1 AA, AC4/A11y).
 *
 * @param {{ status: string }} props
 */
function StatusBadge({ status }) {
  const label = status || '—';
  const badgeStyle = STATUS_BADGE_STYLES[label] ?? STATUS_BADGE_STYLES._default;
  return (
    <span
      style={{ ...styles.statusBadge, ...badgeStyle }}
      aria-label={`Status: ${label}`}
    >
      {label}
    </span>
  );
}

const STATUS_BADGE_STYLES = {
  // ideen-inbox AC1: eigener Farbton für „Idee" (Contrast: #67e8f9 on #0f2a2a ≈ 10.5:1 — WCAG AA).
  'Idee':        { background: '#0f2a2a', color: '#67e8f9', borderColor: '#164e4e' },
  'To Do':       { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
  'In Progress': { background: '#2a1a1a', color: '#fde68a', borderColor: '#78350f' },
  'Blocked':     { background: '#2a1a1a', color: '#f87171', borderColor: '#7f1d1d' },
  'In Review':   { background: '#2a1a2a', color: '#d8b4fe', borderColor: '#581c87' },
  'Done':        { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  // board-status-verworfen AC2 (S-242): gedämpft-neutraler Grauton, klar vom
  // grünen „Done"-Ton abgesetzt; Bedeutung trägt der sichtbare Text „Verworfen".
  // Contrast: #d1d5db on #262626 ≈ 10.3:1 — WCAG AA.
  'Verworfen':   { background: '#262626', color: '#d1d5db', borderColor: '#3f3f46' },
  _default:      { background: '#2a2a2a', color: '#9ca3af', borderColor: '#4b5563' },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Main landmark
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  h1: {
    margin: '0 0 16px',
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
    flexShrink: 0,
  },

  // ── Status / hint messages
  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
  },
  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
  },

  // story-specify-finalize-visibility AC6 (S-240): nicht-blockierender Board-
  // Hinweis (letzter Finalize no-op/failed/auth-expired). Nicht nur Farbe:
  // ⚠-Icon + Text. #fca5a5 on #2a1a1a ≈ 6.2:1 — WCAG AA.
  finalizeHint: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: '#fca5a5',
    fontSize: 13,
    fontWeight: 600,
    padding: '10px 14px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
    flexShrink: 0,
  },
  finalizeHintIcon: {
    fontSize: 16,
    lineHeight: 1,
  },
  finalizeHintText: {
    flex: 1,
  },
  finalizeHintDismiss: {
    minWidth: 32,
    minHeight: 32,
    padding: '4px 8px',
    background: 'transparent',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    flexShrink: 0,
  },
  hintMsg: {
    color: '#6b7280',
    fontSize: 13,
    margin: '4px 0',
    fontStyle: 'italic',
  },

  // ── Back button (standalone project-detail view — AC6)
  backBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 44,
    marginBottom: 12,
    // Focus ring preserved
  },

  // ── Standalone project list (AC6)
  projectListItem: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '12px 16px',
    marginBottom: 8,
  },
  projectListItemContent: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  projectListBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved
  },
  projectListSlug: {
    fontSize: 14,
    fontWeight: 600,
    color: '#e5e7eb',
    fontFamily: 'monospace',
  },
  projectListMeta: {
    fontSize: 12,
    color: '#6b7280',
  },

  // ── Filter bar (AC4, studis-kanban-board-ux)
  filterBar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '8px 12px',
    marginBottom: 20,
    padding: '12px 16px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
  },
  filterLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: '#9ca3af',
    letterSpacing: '0.04em',
  },
  filterFieldset: {
    border: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  // AC4: popover container (relative positioning anchor)
  popoverContainer: {
    position: 'relative',
    display: 'inline-block',
  },
  // AC4: button "Status (n/N) ▾"
  statusPopoverBtn: {
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved
  },
  // AC4: floating popover panel
  statusPopover: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    zIndex: 100,
    background: '#1a1a1a',
    border: '1px solid #333',
    borderRadius: 8,
    padding: '12px 16px',
    minWidth: 160,
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  // AC7: „Alle/Keine"-Toggle — übergeordnete Aktion, optisch leicht nach links
  // versetzt gegenüber den Checkbox-Einträgen. Focus ring bleibt erhalten (kein outline:none).
  statusToggleAllBtn: {
    alignSelf: 'flex-start',
    marginLeft: -6,
    marginBottom: 6,
    background: 'transparent',
    border: '1px solid #444',
    color: '#93c5fd',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 28,
  },
  statusCheckboxCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  statusCheckboxRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
  },
  statusCheckboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    color: '#e5e7eb',
    cursor: 'pointer',
    minHeight: 28,
    // Focus ring on the checkbox input itself is preserved
  },
  statusCheckbox: {
    accentColor: '#93c5fd',
    cursor: 'pointer',
  },
  filterSelect: {
    background: '#1a1a1a',
    border: '1px solid #333',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 13,
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },
  filterReset: {
    background: 'transparent',
    border: '1px solid #444',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    // Focus ring preserved (no outline:none)
  },

  // ── Project list
  projectList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
  },

  projectSection: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '16px 20px',
  },

  projectHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 8,
    marginBottom: 12,
    paddingBottom: 12,
    borderBottom: '1px solid #2a2a2a',
  },

  projectTitle: {
    margin: 0,
    fontSize: 17,
    fontWeight: 700,
    color: '#e5e7eb',
  },

  repoBadge: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'monospace',
  },

  errorBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    borderRadius: 10,
    background: '#2a1a1a',
    color: '#f87171',
    border: '1px solid #7f1d1d',
  },

  // ── run-state-live-view: RunsSummary (aktive Feature-Läufe)
  runsSummary: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginBottom: 14,
  },

  runsSummaryItem: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
    background: '#16202c',
    border: '1px solid #23405c',
    borderRadius: 6,
    fontSize: 12,
  },

  runsSummaryFeature: {
    fontWeight: 700,
    color: '#93c5fd',
  },

  runsSummaryPhase: {
    color: '#e5e7eb',
  },

  runsSummaryDetail: {
    color: '#9ca3af',
  },

  runsSummaryError: {
    color: '#f87171',
    fontWeight: 600,
  },

  // ── Feature row
  featureRow: {
    marginBottom: 16,
    paddingBottom: 16,
    borderBottom: '1px solid #1e1e1e',
  },

  featureHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },

  featureTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#d1d5db',
    flex: 1,
    minWidth: 0,
  },

  // AC1 (board-feature-collapse): Collapse-Button — blendet Story-Spalten aus
  // Der Hauptschalter mit Chevron + Titel; flex:1 damit er den Raum ausfüllt.
  featureCollapseBtn: {
    background: 'transparent',
    border: 'none',
    padding: '2px 0',
    fontSize: 14,
    fontWeight: 600,
    color: '#d1d5db',
    cursor: 'pointer',
    textAlign: 'left',
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    // Focus ring preserved (no outline:none)
  },

  // AC2 (board-feature-collapse): Detail-Schalter (Ziel/DoD) — separater, kleiner Button
  // kein flex:1; rechts positioniert im Header
  featureTitleBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    padding: '2px 6px',
    fontSize: 11,
    color: '#6b7280',
    cursor: 'pointer',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    flexShrink: 0,
    // Focus ring preserved (no outline:none)
  },
  featureTitleChevron: {
    fontSize: 10,
    color: '#6b7280',
    flexShrink: 0,
  },

  // AC4 (board-feature-collapse): „Alle einklappen/ausklappen"-Button in der FilterBar
  collapseAllBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },

  // ── Archiv-Button + Bestätigungsabfrage (board-feature-archive AC5/AC7) ──────
  archiveDoneBtn: {
    background: 'transparent',
    border: '1px solid #4b5563',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // :disabled wird per opacity/cursor via inline nicht möglich — jsdom-neutral;
    // der disabled-Zustand kommt vom DOM-Attribut (aria/Testbarkeit).
    // Focus ring preserved (no outline:none)
  },
  archiveBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.6)',
    zIndex: 999,
  },
  archiveDialog: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 1000,
    background: '#1a1a1a',
    border: '1px solid #374151',
    borderRadius: 10,
    padding: '24px 28px',
    minWidth: 360,
    maxWidth: 480,
    color: '#e5e7eb',
    fontFamily: 'system-ui, sans-serif',
    fontSize: 14,
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
  },
  archiveHeading: {
    margin: '0 0 8px',
    fontSize: 18,
    fontWeight: 700,
    color: '#f0f9ff',
  },
  archiveBody: {
    margin: '0 0 16px',
    fontSize: 14,
    color: '#d1d5db',
    lineHeight: 1.5,
  },
  archiveError: {
    margin: '0 0 12px',
    padding: '8px 12px',
    fontSize: 13,
    color: '#fecaca',
    background: '#3f1d1d',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
  },
  archiveActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
  },
  archiveCancelBtn: {
    background: 'transparent',
    border: '1px solid #4b5563',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 40,
    // Focus ring preserved (no outline:none)
  },
  archiveConfirmBtn: {
    background: '#b45309',
    border: '1px solid #b45309',
    color: '#fff',
    borderRadius: 4,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 40,
    // Focus ring preserved (no outline:none)
  },

  // ── „Archiv anzeigen"-Schalter + Read-only-Markierung (board-feature-archive AC6/AC7) ──
  // Toggle-Button in der FilterBar — echter <button> mit aria-pressed.
  archiveToggleBtn: {
    background: 'transparent',
    border: '1px solid #334155',
    color: '#9ca3af',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },

  // AC8 (bereichs-modell, S-290): „Bereiche verwalten"-Button in der FilterBar.
  areasManageBtn: {
    background: 'transparent',
    border: '1px solid #4b5563',
    color: '#e5e7eb',
    borderRadius: 4,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    minHeight: 36,
    whiteSpace: 'nowrap',
    // Focus ring preserved (no outline:none)
  },
  // „Archiviert"-Badge am Feature-Header — Bedeutung per Text, nicht nur Farbe.
  // #fcd34d on #292018 ≈ 10:1 — WCAG AA (Kontrast in Quelle dokumentiert; jsdom
  // hat keine Layout-Engine, Kontrast daher nicht per Test belegbar).
  archivedBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 10,
    background: '#292018',
    color: '#fcd34d',
    border: '1px solid #78561f',
    flexShrink: 0,
    letterSpacing: '0.02em',
  },
  // Read-only-Feature-Container — reduzierte Opazität (rein visuell, Bedeutung
  // trägt das Text-Badge, nicht die Farbe/Deckkraft).
  featureRowArchived: {
    opacity: 0.72,
  },
  // Read-only-Story-Karte — dezent abgesetzt (visuell); Marker-Text trägt Bedeutung.
  storyCardArchived: {
    opacity: 0.78,
    borderStyle: 'dashed',
    borderColor: '#3a3320',
  },
  // „Archiviert"-Marker an der Story-Karte (Randfall einzeln archivierter Story).
  storyArchivedMarker: {
    margin: '0 0 4px',
    fontSize: 10,
    fontWeight: 700,
    color: '#fcd34d',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },

  // Feature detail panel (goal, DoD, priority, depends, labels)
  featureDetail: {
    marginBottom: 10,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #1e2a3a',
    borderRadius: 6,
  },
  detailDl: {
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '4px 12px',
    alignItems: 'baseline',
  },
  detailTerm: {
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    letterSpacing: '0.04em',
    whiteSpace: 'nowrap',
    margin: 0,
  },
  detailDesc: {
    fontSize: 12,
    color: '#9ca3af',
    margin: 0,
    lineHeight: 1.5,
  },

  dependsChip: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 10,
    background: '#1e2a1e',
    color: '#86efac',
    border: '1px solid #14532d',
  },

  // ── Rollup bar (AC5)
  rollupContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  rollupText: {
    fontSize: 11,
    color: '#9ca3af',
    fontFamily: 'monospace',
    flexShrink: 0,
  },
  rollupTrack: {
    width: 80,
    height: 6,
    background: '#2a2a2a',
    borderRadius: 3,
    overflow: 'hidden',
  },
  rollupFill: {
    height: '100%',
    background: '#86efac',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },

  // ── Status columns (AC4 — Kanban-style)
  // gridTemplateColumns folgt STATUS_LIFECYCLE.length dynamisch (ideen-inbox AC1
  // fügt „Idee" hinzu, board-status-verworfen AC1 fügt „Verworfen" hinzu — 7
  // Spalten; kein hartcodiertes repeat(N,...) mehr).
  statusColumns: {
    display: 'grid',
    gridTemplateColumns: `repeat(${STATUS_LIFECYCLE.length}, minmax(0, 1fr))`,
    gap: 8,
  },

  statusColumn: {
    minWidth: 0,
    background: '#0d0d0d',
    borderRadius: 6,
    padding: '8px 8px',
    border: '1px solid #222',
  },

  columnHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },

  columnCount: {
    fontSize: 11,
    color: '#6b7280',
    background: '#1e1e1e',
    borderRadius: 10,
    padding: '1px 6px',
  },

  // ── Story card
  storyCard: {
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    padding: '8px 10px',
    marginBottom: 4,
  },

  storyHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },

  storyId: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'monospace',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  storyTitle: {
    margin: '0 0 4px',
    fontSize: 12,
    color: '#d1d5db',
    lineHeight: 1.4,
  },

  priorityBadge: {
    fontSize: 10,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    flexShrink: 0,
  },

  // AC4 (autonome-board-abarbeitung): ready badge — dezent, grün-tonal
  // #86efac on #1a2a1a: contrast ≈ 5.5:1 — WCAG AA compliant
  readyBadge: {
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1a2a1a',
    color: '#86efac',
    border: '1px solid #14532d',
    flexShrink: 0,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },

  // idea-specify-background-status AC3: Lauf-Indikator „wird spezifiziert…"
  // #67e8f9 on #0f2a2a ≈ 10.5:1 — WCAG AA (Farbton wie Idee-Status-Badge).
  specifyRunningBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    margin: '4px 0',
    fontSize: 11,
    fontWeight: 600,
    color: '#67e8f9',
    background: '#0f2a2a',
    border: '1px solid #164e4e',
    borderRadius: 4,
    padding: '2px 6px',
    lineHeight: 1.4,
  },
  specifySpinner: {
    fontSize: 12,
    lineHeight: 1,
  },

  // idea-specify-background-status AC4: nicht-blockierender Fehler-Hinweis.
  // #fca5a5 on #2a1a1a ≈ 6.2:1 — WCAG AA. Nicht nur farblich (Text + ⚠-Icon).
  specifyErrorBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    margin: '4px 0',
    fontSize: 11,
    fontWeight: 600,
    color: '#fca5a5',
    background: '#2a1a1a',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    padding: '2px 6px',
    lineHeight: 1.4,
  },

  // AC4: blocked_reason display for Blocked stories
  // #fbbf24 on #1a1a1a: contrast ≈ 6.9:1 — WCAG AA compliant
  blockedReason: {
    margin: '2px 0 4px',
    fontSize: 11,
    color: '#fbbf24',
    lineHeight: 1.4,
    fontStyle: 'italic',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    // Allow wrapping for accessibility — do not force single line for long reasons
    whiteSpace: 'normal',
    wordBreak: 'break-word',
  },

  labelRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    marginBottom: 4,
  },

  labelChip: {
    fontSize: 10,
    padding: '1px 6px',
    borderRadius: 10,
    background: '#1e293b',
    color: '#a5b4fc',
    border: '1px solid #312e81',
  },

  specRef: {
    display: 'flex',
    gap: 4,
    marginTop: 4,
  },
  specLabel: {
    fontSize: 10,
    color: '#4b5563',
  },
  specValue: {
    fontSize: 10,
    color: '#6b7280',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // AC5: klickbarer Spec-Link (Button-Reset-Stil, aber sichtbar klickbar)
  specLink: {
    fontSize: 10,
    color: '#93c5fd',
    fontFamily: 'monospace',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    textDecoration: 'underline',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA / design.md)
    // Focus ring preserved (no outline:none)
  },

  // ── Status badge (text label — not only colour)
  statusBadge: {
    display: 'inline-block',
    padding: '2px 6px',
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 10,
    border: '1px solid',
    flexShrink: 0,
  },

  // ── Story card as clickable button (AC3 story-detail-ansicht)
  storyCardBtn: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA)
    // Focus ring preserved (no outline:none)
  },

  // ── Idee-Karte + Spezifizieren-Trigger (idea-specify-chat AC1/AC2, S-218)
  ideaCardWrapper: {
    marginBottom: 4,
  },

  ideaSpecifyBtn: {
    display: 'block',
    width: '100%',
    marginTop: 2,
    minHeight: 32,
    padding: '4px 10px',
    background: 'transparent',
    border: '1px dashed #374151',
    borderRadius: 4,
    color: '#9ca3af',
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'center',
    // Contrast: #9ca3af on transparent (effektiv #1a1a1a Karten-Hintergrund) ≈ 5.6:1 (WCAG AA).
  },

  // ── Story Detail View (AC3/AC4 story-detail-ansicht)
  detailBlocks: {
    display: 'flex',
    flexDirection: 'column',
    gap: 20,
  },

  detailBlock: {
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    padding: '16px 20px',
  },

  detailBlockTitle: {
    margin: '0 0 12px',
    fontSize: 15,
    fontWeight: 700,
    color: '#e5e7eb',
    borderBottom: '1px solid #2a2a2a',
    paddingBottom: 8,
  },

  // ── Flow / Soll-Ist table
  flowTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
    color: '#d1d5db',
  },

  flowTh: {
    textAlign: 'left',
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    borderBottom: '1px solid #2a2a2a',
    letterSpacing: '0.04em',
  },

  flowTd: {
    padding: '5px 8px',
    fontSize: 12,
    color: '#d1d5db',
    borderBottom: '1px solid #1e1e1e',
    fontFamily: 'monospace',
  },

  noEstimate: {
    color: '#6b7280',
    fontStyle: 'italic',
    fontFamily: 'inherit',
  },

  // story-detail-yaml-fallback AC5: YAML-Badge für ended_at aus Board-YAML (done_at)
  // Contrast: #93c5fd on #0d1a2a ≈ 7.1:1 — WCAG AA compliant
  yamlBadge: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#0d1a2a',
    color: '#93c5fd',
    border: '1px solid #1e3a5f',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    verticalAlign: 'middle',
    fontFamily: 'inherit',
  },

  // story-detail-yaml-fallback AC6: monospace Text für Branch-Namen
  monoText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#d1d5db',
  },

  // story-detail-yaml-fallback AC6: PR-Link (externer Link, noopener noreferrer)
  // Contrast: #93c5fd on #111 ≈ 7.1:1 — WCAG AA compliant
  prLink: {
    color: '#93c5fd',
    fontSize: 12,
    fontFamily: 'monospace',
    textDecoration: 'underline',
    // Focus ring preserved (no outline:none)
  },

  // AC5 (story-detail-ansicht): Vorab-Badge — kennzeichnet Schätzung aus Story-YAML
  // Contrast: #fbbf24 on #1a1500 ≈ 10.9:1 — WCAG AA compliant
  vorabBadge: {
    display: 'inline-block',
    marginLeft: 6,
    fontSize: 9,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: '#1a1500',
    color: '#fbbf24',
    border: '1px solid #78350f',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    verticalAlign: 'middle',
    fontFamily: 'inherit',
  },
};
