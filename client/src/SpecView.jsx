/**
 * SpecView.jsx — Reiter „Spezifikation" im Cockpit (AC4, AC5, AC6 — projekt-spezifikation-anzeige).
 *
 * AC4 — Reiter „Spezifikation" im geöffneten Projekt:
 *        Links Navigation (Schicht-Gruppen: Konzept / Architektur / Specs / README),
 *        rechts gerendertes Markdown (markdownLite.jsx).
 *        Ladezustand (aria-busy) beim Nachladen einer Datei.
 *
 * AC5 — Über die openSpec-Prop (vom CockpitView übergeben) kann ein externer Aufrufer
 *        (z.B. BoardView beim Klick auf einen Spec-Bezug) eine Datei direkt öffnen.
 *        SpecView stellt das über den useImperativeHandle-ähnlichen Mechanismus bereit:
 *        CockpitView setzt activeSpecPath als State und übergibt es als Prop.
 *
 * AC6 — Filter nach Doku-Typ (Konzept/Architektur/Spec/README) + Spec-Status
 *        (draft/active/superseded). Mehrfachauswahl konsistent zum Board-Filter-Muster:
 *        Checkboxen in einem kleinen FilterBar-Element.
 *
 * reconcile-trigger (S-201) — Button „Konzept/Spec nachziehen" oben in der Sidebar:
 * AC1 — Button + Hinweistext nennt den ausgelösten Befehl `/agent-flow:reconcile`;
 *        Touch-Target ≥ 44 px.
 * AC2 — Klick (bei freier Session) öffnet Bestätigungsdialog (role="dialog");
 *        noch kein POST.
 * AC3 — **überschrieben durch headless-reconcile-runner (S-208) AC10** — „Starten"
 *        POSTet jetzt genau einmal {projectSlug} an `/api/reconcile` (statt
 *        {command:'/agent-flow:reconcile', projectPath} an /api/command);
 *        „Abbrechen" schließt weiterhin ohne POST.
 * AC4 — Bei `GET /api/session` state:"busy" ist der Button deaktiviert
 *        (disabled-Attribut + Text-Label, nie Farbe allein); kein Dialog/POST bei
 *        Klick. Gilt **weiter** (headless-reconcile-runner-Abhängigkeiten: „Busy-Guard
 *        AC1–AC4 gelten weiter") — unabhängig vom Headless-Runner-Projekt-Lock.
 * AC5 — **überschrieben durch reconcile-inline-feedback (S-205) AC1** — kein
 *        `onNavigate` mehr nach 202; siehe unten.
 * AC6 — **überschrieben durch headless-reconcile-runner (S-208) AC13** — 409 kommt
 *        jetzt vom POST `/api/reconcile` (Headless-Runner-Projekt-Sperre statt
 *        /api/command-409); weiterhin sichtbare Fehleranzeige, kein onNavigate,
 *        kein Crash.
 * AC7 — **überschrieben durch headless-reconcile-runner (S-208) AC13** — Netzwerkfehler/
 *        500/400 vom neuen `/api/reconcile`-Start weiterhin sichtbare Fehleranzeige
 *        mit Reset, kein onNavigate.
 * Gespiegelt vom „Board abarbeiten"-Muster (CockpitView.jsx FactoryWorkspace).
 *
 * reconcile-inline-feedback (S-205) — bleibt auf dem Spezifikation-Reiter, hält
 * den Lauf, meldet Fortschritt inline, refresht die Audit-Anzeige automatisch:
 * AC1 — Nach 202 wird `onNavigate` NICHT mehr aufgerufen (überschreibt
 *        reconcile-trigger AC5); stattdessen inline „Reconcile läuft…"
 *        (role="status"), Button deaktiviert (disabled + Text-Label).
 * AC2 — **überschrieben durch headless-reconcile-runner (S-208) AC11** — die
 *        Fertig-Quelle ist jetzt `GET /api/reconcile/:jobId` (nicht mehr
 *        `GET /api/session`); solange `status:"running"` bleibt „Reconcile
 *        läuft…" sichtbar, Button deaktiviert.
 * AC3 — **überschrieben durch headless-reconcile-runner (S-208) AC12** — Status
 *        `done` (statt „erstmaliges nicht-busy") → „Fertig" (role="status"),
 *        Button wieder auslösbar.
 * AC4 — Beim Übergang auf „Fertig" wird `AuditSpecView` automatisch genau
 *        einmal neu geladen (Reload-Signal-Zähler, kein manueller Klick nötig).
 *        Mechanismus unverändert, jetzt ausgelöst vom Job-Status `done` (AC12)
 *        statt vom Session-Busy-Flip.
 * AC5 — Erkennbarer PR-Bezug (URL oder `#<nummer>`) im Audit-Inhalt → dezenter
 *        Link/Hinweis; sonst kein Element (graceful absence, best-effort).
 *        Unverändert (headless-reconcile-runner AC12 „PR-Hinweis … falls im
 *        result/Audit erkennbar" nutzt denselben Mechanismus).
 * AC6 — Backend: `GET /api/session` meldet `busy` solange ein Reconcile-Job
 *        in Flight ist (CommandService/JobLock-Zustand sichtbar gemacht).
 * AC7 — Backend: `PtySessionRegistry` verwirft eine Session mit aktivem Job
 *        nicht idle — auch ohne WebSocket-Zuschauer.
 * AC8 — **Quelle geändert (headless-reconcile-runner S-208):** Bestätigt der
 *        Job-Poll (`/api/reconcile/:jobId`) den Abschluss nicht innerhalb eines
 *        beschränkten Sicherheitsfensters (Status bleibt dauerhaft „running" /
 *        Poll schlägt wiederholt fehl, z.B. 404 nach Server-Neustart) → neutraler
 *        Text-Hinweis statt Endlos-Spinner; „Audit-Spec anzeigen" bleibt manuell
 *        bedienbar. (Zuvor: Session-Poll: jetzt Job-Poll.)
 * AC9 — **überschrieben durch headless-reconcile-runner (S-208) AC13** — 409/500/
 *        400/Netzwerkfehler vom neuen `/api/reconcile`-Start weiterhin inline
 *        Fehleranzeige mit Reset, ohne `onNavigate`, ohne Crash.
 *
 * headless-reconcile-runner (S-208) — ReconcileTrigger vom `/api/command`+
 * `/api/session`-Fertig-Poll ([[reconcile-inline-feedback]] S-205) auf den
 * Headless-Runner-Endpunkt umgehängt (Ablösung der S-205-Poll-Quelle):
 * AC10 — „Starten" POSTet genau einmal `{projectSlug}` an `POST /api/reconcile`
 *        (statt /api/command) und erhält `202 {jobId}`; inline „Reconcile läuft…"
 *        (role="status"), Button deaktiviert; `onNavigate` weiterhin nicht aufgerufen.
 * AC11 — Im Lauf-Zustand pollt der Trigger `GET /api/reconcile/:jobId` — **nicht**
 *        mehr `/api/session` als Fertig-Quelle. Solange `status:"running"` bleibt
 *        „Reconcile läuft…"; der generische Busy-Guard-Poll gegen `/api/session`
 *        (reconcile-trigger AC4, Fremd-Busy z.B. Flow-/Board-Button) läuft
 *        unabhängig davon weiter.
 * AC12 — Status `done` → „Fertig" (role="status"), Button wieder auslösbar,
 *        `AuditSpecView` automatisch genau einmal neu geladen; PR-Hinweis
 *        best-effort über den bestehenden Audit-Inhalt-Mechanismus (AC5).
 * AC13 — Status `failed` (Job-Poll) → inline Fehler-/Status-Anzeige mit Reset
 *        (role="alert"), kein Crash. `409` beim Start (Headless-Runner-Projekt-
 *        Sperre) → passender Hinweis, kein Crash.
 * AC14 — Status `auth-expired` → klarer Hinweis „Claude-Anmeldung abgelaufen —
 *        Token via `claude setup-token` erneuern" (Text, role="alert", nicht nur
 *        Farbe); kein falsches „Fertig".
 * AC15 — Trigger bleibt entkoppelt testbar über injizierbaren `fetchFn`; kein
 *        Test hängt an einem realen Reconcile-Lauf.
 *
 * spec-audit-view (S-203) — Sekundär-Button „Audit-Spec anzeigen" direkt
 * unterhalb des ReconcileTrigger-Buttons:
 * AC1 — Sekundär-Button „Audit-Spec anzeigen" direkt unterhalb des
 *        ReconcileTrigger-Buttons; Touch-Target ≥ 44 px, Zustand per Text
 *        erkennbar (nicht nur Farbe).
 * AC2 — Klick löst genau einen GET .../docs/raw?path=docs/spec-audit.md aus;
 *        Markdown wird über MarkdownLite gerendert und ist sichtbar.
 * AC3 — 404 (Datei fehlt) → freundlicher Hinweis „noch kein Reconcile-Lauf"
 *        (role="status"), keine rohe Fehlermeldung, kein Crash.
 * AC4 — **überschrieben durch audit-spec-main-pane (S-210) AC4** — Zugänglicher
 *        Lade-Zustand während des Ladens; Netzwerkfehler/500/unerwarteter
 *        Status → sichtbare, neutrale Fehleranzeige (role="alert"), kein
 *        Crash, übriger Reiter bleibt bedienbar. Die Zustände erscheinen jetzt
 *        in der Haupt-Inhaltsfläche statt in der Sidebar.
 *
 * audit-spec-main-pane (S-210) — Ausgabe von AuditSpecView (S-203) verlagert
 * von der schmalen linken Sidebar in die rechte Haupt-Inhaltsfläche (derselbe
 * Content-Container, in dem ein per Navigation gewähltes Dokument erscheint).
 * Der Button selbst bleibt an seiner Stelle in der Sidebar:
 * AC1 — Button bleibt links (Position/Label/Touch-Target unverändert); keine
 *        gerenderte Markdown-Ausgabe mehr innerhalb der Sidebar.
 * AC2 — Klick löst weiterhin genau einen GET .../docs/raw?path=docs/spec-audit.md
 *        aus; Markdown wird über MarkdownLite in der rechten Haupt-
 *        Inhaltsfläche gerendert (gleicher Content-Container/Breite/Padding/
 *        Scroll wie ein per Navigation gewähltes Dokument).
 * AC3 — Umschalten statt Doppelanzeige: Klick auf „Audit-Spec anzeigen"
 *        ersetzt ein ggf. gewähltes Navigations-Dokument in der Hauptfläche
 *        durch das Logbuch (`mainSource` state 'doc'|'audit'); ein
 *        anschließender Navigations-Klick (`handleSelect`) schaltet zurück auf
 *        `doc`. Nie beide gleichzeitig sichtbar.
 * AC4 — Lade-/404-/Fehlerzustand erscheinen jetzt in der Haupt-Inhaltsfläche.
 * AC5 — Der automatische Reload nach Reconcile-Abschluss ([[reconcile-inline-
 *        feedback]] AC4, `reloadSignal`) bleibt erhalten (genau ein Reload);
 *        Edge-Case: zeigt die Hauptfläche gerade aktiv ein per Navigation
 *        gewähltes Dokument (`mainSource === 'doc'` UND `activePath` gesetzt),
 *        schaltet der Auto-Reload die Hauptfläche NICHT unbemerkt auf das
 *        Logbuch um (nur der Hintergrund-Inhalt wird aktualisiert); ohne aktiv
 *        gezeigtes Dokument schaltet er auf `audit` um. Der PR-Bezug-Hinweis
 *        (AC5 reconcile-inline-feedback) bleibt erhalten.
 * AC6 — Security-Floor unverändert (kein neuer Endpunkt, fester Pfad, nur
 *        MarkdownLite, kein dangerouslySetInnerHTML).
 * AC7 — `useAuditSpec`-Hook bleibt über injizierbaren `fetchFn` entkoppelt
 *        testbar (kein Test hängt an einem realen Reconcile-Lauf).
 *
 * obsidian-sync-trigger (S-252) — Button „Notizen-Stand abgleichen" (Obsidian-
 * Sync), direkt unterhalb des Audit-Spec-Buttons (im selben Reiter neben/
 * analog zum ReconcileTrigger, s. Render unten). Spiegelt dessen
 * Dialog-/Busy-Guard-/Fehler-Muster (AC1/AC2/AC4/reconcile-trigger); anders
 * als der (mittlerweile headless umgehängte) ReconcileTrigger POSTet dieser
 * Trigger weiterhin **unverändert** über `POST /api/command` (Muster
 * [[obsidian-project-intake]]/[[flow-trigger]]):
 * AC1 — Button + Hinweistext (nennt `/agent-flow:from-notes --sync`, „zeigt
 *        Widersprüche an, überschreibt nicht blind"); Touch-Target ≥ 44 px.
 *        Ohne konfigurierten Vault (`GET /api/settings/obsidian-vault-path`
 *        → `configured:false`) disabled + Text-Hinweis.
 * AC2 — Klick (freie Session + konfigurierter Vault) öffnet einen
 *        Bestätigungsdialog (`role="dialog"`); noch kein POST.
 * AC3 — **Präzisierung (löst A1, s. Spec „Offene Annahmen"):** der Dialog
 *        lädt `GET /api/settings/obsidian-vault/projects` und lässt den
 *        Nutzer den passenden Vault-Projektordner explizit auswählen
 *        (kein persistiertes Projekt↔Ordner-Mapping vorhanden). „Starten"
 *        bleibt deaktiviert, bis ein Ordner gewählt ist; POSTet dann **genau
 *        einmal** `{ command: '/agent-flow:from-notes --sync <path>',
 *        projectPath }` an `/api/command`. „Abbrechen" schließt ohne POST.
 * AC4 — Backend-Allowlist: `/agent-flow:from-notes` (inkl. `--sync`) bereits
 *        zulässig (S-248) — siehe `test/CommandService.test.js`.
 * AC5 — Bei `GET /api/session` → `busy` ist der Button deaktiviert (Text +
 *        disabled); Klick öffnet keinen Dialog, kein POST.
 * AC6 — **Präzisierung (Iteration 2, löst einen live nachgewiesenen Bug):**
 *        `202` → Wechsel in den „Arbeiten"-Reiter über den dedizierten
 *        `onShowArbeiten`-Callback (CockpitView `handleShowArbeiten`,
 *        gespiegelt vom openSpec-/onShowBoard-Muster) — NICHT über das
 *        generische App-Level `onNavigate('factory')`
 *        (`useHashRouter.navigate`): das hätte den Hash von
 *        `#/factory/<repo>` auf das bare `#/factory` zurückgesetzt
 *        (`viewToHash` kennt kein Repo-Segment) und den Projekt-Kontext
 *        verloren (Nutzer landet auf der Repo-Übersicht statt im Cockpit —
 *        live per App-Integrationstest nachgewiesen). Kein stehengebliebenes
 *        Element (Phase wird auf `idle` zurückgesetzt, SpecView/Spec-Reiter
 *        unmountet beim Tab-Wechsel).
 * AC7 — `409`/`400`/`500`/Netzwerkfehler → sichtbare Fehleranzeige mit
 *        Reset, kein Tab-Wechsel, kein Crash.
 * Edge-Case (A1, „kann nicht bestimmt werden"): leere/fehlerhafte
 * Projektordner-Liste → Fehlerhinweis im Dialog, „Starten" bleibt deaktiviert.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/board/projects/:slug/docs Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *   - Markdown via vorhandenen markdownLite-Renderer (kein fremder Parser).
 *   - reconcile-trigger: Bestätigungsdialog verhindert versehentliches Auslösen.
 *   - headless-reconcile-runner: `POST /api/reconcile` sendet nur `{projectSlug}`
 *     (Server löst den Pfad auf, kein absoluter Host-Pfad im Client-Request/-State);
 *     `jobId` ist eine reine Korrelations-ID (kein Secret); `error`/`result` aus
 *     der Job-Antwort kommen bereits secret-/pfad-frei vom Server (AC9 Backend-Spec)
 *     und werden hier nur als Text angezeigt (kein dangerouslySetInnerHTML).
 *   - spec-audit-view: kein neuer Endpunkt — wiederverwendet den bestehenden
 *     docs/raw-Endpunkt mit festem, nicht nutzergesteuertem Pfad
 *     (docs/spec-audit.md — kein Traversal-Vektor).
 *   - reconcile-inline-feedback: PR-Link nur aus dem gerenderten Audit-Inhalt
 *     (fester https?://-Präfix), `target="_blank"` stets mit
 *     `rel="noopener noreferrer"` (kein offener Redirect).
 *   - obsidian-sync-trigger: kein neuer Backend-Endpunkt, keine neue Trust-
 *     Boundary — der `<path>` stammt ausschließlich aus der server-confined
 *     Vault-Projekt-Liste (kein Freitext); Bestätigungsdialog verhindert
 *     versehentliches Auslösen; Befehl durchläuft die unveränderte
 *     Sanitisierung/Allowlist ([[flow-trigger]] AC2).
 *
 * A11y (WCAG 2.1 AA):
 *   - Navigation als <nav> mit aria-label.
 *   - Aktives Dokument mit aria-current="page".
 *   - Ladezustand aria-busy auf dem Inhalts-Container.
 *   - Fokusring nie unterdrückt.
 *   - Touch-Targets ≥ 44 px für Nav-Buttons, den Reconcile-Button und den
 *     Audit-Spec-Button.
 *   - Lauf-/Fertig-/Degraded-Zustände (S-205) als Text (role="status",
 *     aria-live="polite"), nicht nur Farbe.
 *
 * Covers (reconcile-trigger): AC1, AC2, AC4 (AC3/AC6/AC7 überschrieben — siehe
 *   headless-reconcile-runner AC10/AC13; AC5 überschrieben — siehe reconcile-inline-feedback AC1)
 * Covers (spec-audit-view): AC1, AC2, AC3 (AC4 überschrieben — siehe audit-spec-main-pane AC4)
 * Covers (reconcile-inline-feedback): AC1, AC4, AC5 (AC2/AC3/AC9 überschrieben — siehe
 *   headless-reconcile-runner AC11/AC12/AC13; AC8-Mechanismus jetzt job-poll-basiert
 *   — siehe headless-reconcile-runner; AC6/AC7 sind Backend — siehe src/routers/session.js, src/PtySessionRegistry.js)
 * Covers (headless-reconcile-runner): AC10, AC11, AC12, AC13, AC14, AC15
 * Covers (audit-spec-main-pane): AC1, AC2, AC3, AC4, AC5, AC6, AC7
 * Covers (obsidian-sync-trigger): AC1, AC2, AC3, AC5, AC6, AC7 (AC4 — Backend-
 *   Allowlist — siehe test/CommandService.test.js)
 *
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 *   onNavigate?: (view: string) => void,
 *   onShowArbeiten?: () => void,
 *   fetchFn?: Function,
 *   reconcilePollInterval?: number,
 *   reconcileSafetyWindowMs?: number,
 *   reconcileMaxConsecutiveFailures?: number,
 *   obsidianSyncPollInterval?: number,
 * }} props
 *   projectSlug   — Slug des aktiven Projekts (aus CockpitView/BoardAggregator)
 *   initialPath   — optional: direkt zu öffnende Datei (AC5, z.B. via Story-Klick)
 *   onNavigate    — nicht mehr genutzt (weder vom Reconcile-Trigger seit S-205
 *                    AC1, noch vom ObsidianSyncTrigger — s. onShowArbeiten
 *                    unten); Prop bleibt für Signatur-Kompatibilität mit
 *                    CockpitView erhalten, aber ungenutzt.
 *   onShowArbeiten — (obsidian-sync-trigger AC6, Präzisierung Iteration 2)
 *                    aufgerufen nach `202` — schaltet CockpitView auf den
 *                    „Arbeiten"-Reiter (lokaler Tab-Wechsel, kein Hash-/App-
 *                    Level-Navigate, s. ObsidianSyncTrigger unten).
 *   fetchFn       — injectable für Tests (default: globalThis.fetch); vom
 *                    Reconcile-Trigger, Audit-Spec-Button UND ObsidianSyncTrigger
 *                    genutzt (Doku-Laden im Nav-Baum bleibt unverändert).
 *   reconcilePollInterval, reconcileSafetyWindowMs, reconcileMaxConsecutiveFailures —
 *                    injectable Test-Overrides für den Reconcile-Session-Poll
 *                    (S-205 AC2/AC8; Defaults siehe ReconcileTrigger unten).
 *   obsidianSyncPollInterval — injectable Test-Override für den Busy-Guard-Poll
 *                    des ObsidianSyncTrigger (obsidian-sync-trigger AC5).
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MarkdownLite } from './markdownLite.jsx';

// ── Typ-Konstanten ─────────────────────────────────────────────────────────────

/** Alle Doku-Typen (AC6 Filter). */
const ALL_DOC_TYPES = ['readme', 'konzept', 'architektur', 'spec'];

/** Lesbare Label je Typ. */
const TYPE_LABELS = {
  readme:      'README',
  konzept:     'Konzept',
  architektur: 'Architektur',
  spec:        'Spec',
};

/** Alle Spec-Status-Werte (AC6 Filter). */
const ALL_SPEC_STATUSES = ['draft', 'active', 'superseded'];

// ── SpecView ──────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   projectSlug: string,
 *   initialPath?: string | null,
 *   onNavigate?: (view: string) => void,
 *   onShowArbeiten?: () => void,
 *   fetchFn?: Function,
 *   reconcilePollInterval?: number,
 *   reconcileSafetyWindowMs?: number,
 *   reconcileMaxConsecutiveFailures?: number,
 *   obsidianSyncPollInterval?: number,
 * }} props
 */
export function SpecView({
  projectSlug,
  initialPath,
  // Nicht mehr genutzt (weder ReconcileTrigger seit S-205 AC1, noch
  // ObsidianSyncTrigger — s. onShowArbeiten); Signatur-Kompatibilität.
  onNavigate: _onNavigate,
  onShowArbeiten,
  fetchFn,
  reconcilePollInterval,
  reconcileSafetyWindowMs,
  reconcileMaxConsecutiveFailures,
  obsidianSyncPollInterval,
}) {
  // ── Doku-Struktur (Navigation) ─────────────────────────────────────────────
  const [docsState, setDocsState] = useState('idle');  // 'idle'|'loading'|'ok'|'error'
  const [docsError, setDocsError] = useState('');
  /** @type {[import('./SpecView.jsx').DocEntry[], Function]} */
  const [docs, setDocs] = useState([]);

  // ── Aktives Dokument ───────────────────────────────────────────────────────
  const [activePath, setActivePath] = useState(initialPath ?? null);
  const [contentState, setContentState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [contentError, setContentError] = useState('');
  const [content, setContent] = useState('');

  // ── Filter-State (AC6) ────────────────────────────────────────────────────
  /** @type {[Set<string>, Function]} */
  const [filterTypes, setFilterTypes]     = useState(() => new Set(ALL_DOC_TYPES));
  /** @type {[Set<string>, Function]} */
  const [filterStatuses, setFilterStatuses] = useState(() => new Set(ALL_SPEC_STATUSES));

  // ── reconcile-inline-feedback (S-205) AC4: Audit-Reload-Signal ────────────
  // Zähler, der bei jedem Reconcile-Abschluss ("Fertig") hochgezählt wird.
  // useAuditSpec beobachtet die Änderung (reloadSignal-Prop) und lädt
  // daraufhin automatisch genau einmal neu (Edge-Case „Doppel-Reload").
  const [auditReloadSignal, setAuditReloadSignal] = useState(0);
  const handleReconcileDone = useCallback(() => {
    setAuditReloadSignal((n) => n + 1);
  }, []);

  // ── audit-spec-main-pane (S-210): Haupt-Inhaltsfläche-Quelle ──────────────
  // 'doc'   — zeigt das per Navigation gewählte Dokument (activePath/content*)
  // 'audit' — zeigt das Audit-Logbuch (useAuditSpec-State)
  // Nie beide gleichzeitig (AC3).
  const [mainSource, setMainSource] = useState('doc');

  // Refs für die Auto-Reload-Entscheidung (AC5 Edge-Case): der automatische
  // Reload nach Reconcile-Abschluss darf ein AKTIV gezeigtes Navigations-
  // Dokument nicht unbemerkt aus der Hauptfläche verdrängen — er greift nur,
  // wenn gerade KEIN Dokument aktiv gezeigt wird (bzw. das Logbuch bereits
  // sichtbar ist). Refs statt Deps, damit der Reload-Effect in useAuditSpec
  // nicht bei jeder mainSource-/activePath-Änderung neu registriert wird.
  const activePathRef = useRef(activePath);
  useEffect(() => { activePathRef.current = activePath; }, [activePath]);
  const mainSourceRef = useRef(mainSource);
  useEffect(() => { mainSourceRef.current = mainSource; }, [mainSource]);

  const handleAuditAutoReload = useCallback(() => {
    const hasActiveDoc = mainSourceRef.current === 'doc' && !!activePathRef.current;
    if (!hasActiveDoc) {
      setMainSource('audit');
    }
  }, []);

  const audit = useAuditSpec({
    projectSlug,
    fetchFn,
    reloadSignal: auditReloadSignal,
    onAutoReload: handleAuditAutoReload,
  });
  const { load: auditLoad } = audit;

  const handleAuditClick = useCallback(() => {
    setMainSource('audit');
    auditLoad();
  }, [auditLoad]);

  // ── Doku-Struktur laden (beim Mount + wenn Slug wechselt) ─────────────────
  useEffect(() => {
    if (!projectSlug) return;

    let cancelled = false;
    setDocsState('loading');
    setDocsError('');
    setDocs([]);

    fetch(`/api/board/projects/${encodeURIComponent(projectSlug)}/docs`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setDocs(data.docs ?? []);
        setDocsState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setDocsError(err.message || 'Netzwerkfehler');
        setDocsState('error');
      });

    return () => { cancelled = true; };
  }, [projectSlug]);

  // ── initialPath-Prop-Änderung → aktivieren (AC5) ──────────────────────────
  useEffect(() => {
    if (initialPath) {
      setActivePath(initialPath);
    }
  }, [initialPath]);

  // ── Dateiinhalt laden wenn activePath wechselt ────────────────────────────
  useEffect(() => {
    if (!activePath || !projectSlug) return;

    let cancelled = false;
    setContentState('loading');
    setContentError('');
    setContent('');

    const url = `/api/board/projects/${encodeURIComponent(projectSlug)}/docs/raw?path=${encodeURIComponent(activePath)}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setContentState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setContentError(err.message || 'Netzwerkfehler');
        setContentState('error');
      });

    return () => { cancelled = true; };
  }, [activePath, projectSlug]);

  // ── Filter-Logik (AC6) ────────────────────────────────────────────────────
  const filteredDocs = useMemo(() => {
    return docs.filter((d) => {
      // Typ-Filter
      if (!filterTypes.has(d.type)) return false;
      // Status-Filter: nur bei Specs; andere Typen werden nicht nach Status gefiltert
      if (d.type === 'spec' && d.status) {
        if (!filterStatuses.has(d.status)) return false;
      }
      return true;
    });
  }, [docs, filterTypes, filterStatuses]);

  // Gruppierung nach Typ (für Navigation)
  const groupedDocs = useMemo(() => {
    /** @type {Record<string, typeof filteredDocs>} */
    const groups = { readme: [], konzept: [], architektur: [], spec: [] };
    for (const d of filteredDocs) {
      if (groups[d.type]) groups[d.type].push(d);
    }
    return groups;
  }, [filteredDocs]);

  // ── Callback: Dokument öffnen ─────────────────────────────────────────────
  const handleSelect = useCallback((path) => {
    setActivePath(path);
    // audit-spec-main-pane (S-210) AC3: Navigations-Klick schaltet die
    // Hauptfläche zurück auf das Dokument (Logbuch verschwindet).
    setMainSource('doc');
  }, []);

  // ── Filter-Toggle-Callbacks ────────────────────────────────────────────────
  const toggleType = useCallback((type) => {
    setFilterTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) { next.delete(type); } else { next.add(type); }
      return next;
    });
  }, []);

  const toggleStatus = useCallback((status) => {
    setFilterStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) { next.delete(status); } else { next.add(status); }
      return next;
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {/* Linke Spalte: Reconcile-Trigger + Filter + Navigation */}
      <div style={styles.sidebar} data-testid="specview-sidebar">
        {/* reconcile-trigger (S-201) + reconcile-inline-feedback (S-205):
            „Konzept/Spec nachziehen"-Button, bleibt auf dem Reiter (kein
            onNavigate mehr), meldet Lauf/Fertig inline. */}
        <ReconcileTrigger
          projectSlug={projectSlug}
          fetchFn={fetchFn}
          onDone={handleReconcileDone}
          pollInterval={reconcilePollInterval}
          safetyWindowMs={reconcileSafetyWindowMs}
          maxConsecutiveFailures={reconcileMaxConsecutiveFailures}
        />

        {/* spec-audit-view (S-203): „Audit-Spec anzeigen"-Button, direkt unterhalb.
            audit-spec-main-pane (S-210): Button bleibt hier — die Ausgabe
            rendert jetzt in der Haupt-Inhaltsfläche (unten). */}
        <AuditSpecButton
          disabled={audit.isBtnDisabled}
          onClick={handleAuditClick}
        />

        {/* obsidian-sync-trigger (S-252): „Notizen-Stand abgleichen"-Button,
            im selben Reiter neben/analog zum Reconcile-Trigger. */}
        <ObsidianSyncTrigger
          projectSlug={projectSlug}
          fetchFn={fetchFn}
          onShowArbeiten={onShowArbeiten}
          pollInterval={obsidianSyncPollInterval}
        />

        {/* Filter (AC6) */}
        <SpecFilterBar
          filterTypes={filterTypes}
          filterStatuses={filterStatuses}
          onToggleType={toggleType}
          onToggleStatus={toggleStatus}
        />

        {/* Navigations-Baum */}
        <nav style={styles.nav} aria-label="Dokument-Navigation">
          {docsState === 'loading' && (
            <div style={styles.navHint} aria-busy="true" aria-live="polite">
              Lade Dokument-Liste…
            </div>
          )}
          {docsState === 'error' && (
            <div style={styles.navError} role="alert">
              Fehler: {docsError}
            </div>
          )}
          {docsState === 'ok' && filteredDocs.length === 0 && (
            <div style={styles.navHint} role="status">
              Keine Dokumente gefunden.
            </div>
          )}
          {docsState === 'ok' && filteredDocs.length > 0 && (
            <>
              {ALL_DOC_TYPES.filter((t) => filterTypes.has(t) && groupedDocs[t]?.length > 0).map((type) => (
                <NavGroup
                  key={type}
                  label={TYPE_LABELS[type]}
                  entries={groupedDocs[type]}
                  activePath={activePath}
                  onSelect={handleSelect}
                />
              ))}
            </>
          )}
        </nav>
      </div>

      {/* Rechte Spalte: Markdown-Inhalt — audit-spec-main-pane (S-210) AC3:
          genau eine sichtbare Quelle (`mainSource`): Navigations-Dokument
          ODER Audit-Logbuch, nie beide gleichzeitig. */}
      <div
        style={styles.content}
        aria-busy={mainSource === 'audit' ? audit.auditState === 'loading' : contentState === 'loading'}
        aria-live="polite"
        data-testid="specview-content"
      >
        {mainSource === 'doc' && (
          <>
            {!activePath && (
              <div style={styles.contentHint} role="status">
                Dokument aus der Navigation auswählen.
              </div>
            )}
            {activePath && contentState === 'loading' && (
              <div style={styles.contentHint} aria-busy="true">
                Lade Dokument…
              </div>
            )}
            {activePath && contentState === 'error' && (
              <div style={styles.contentError} role="alert">
                Fehler beim Laden: {contentError}
              </div>
            )}
            {activePath && contentState === 'ok' && (
              <div style={styles.markdownWrapper}>
                <MarkdownLite markdown={content} style={styles.markdown} />
              </div>
            )}
          </>
        )}

        {/* audit-spec-main-pane (S-210) AC2/AC4: Audit-Logbuch-Zustände in
            der Haupt-Inhaltsfläche (gleicher Container/Breite/Padding/Scroll
            wie ein Navigations-Dokument, statt der schmalen Sidebar). */}
        {mainSource === 'audit' && (
          <>
            {audit.auditState === 'loading' && (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                style={styles.contentHint}
                data-testid="audit-spec-loading"
              >
                Lade Audit-Spec…
              </div>
            )}
            {audit.auditState === 'notfound' && (
              <div role="status" style={styles.contentHint} data-testid="audit-spec-notfound">
                Noch kein Reconcile-Lauf.
              </div>
            )}
            {audit.auditState === 'error' && (
              <div role="alert" style={styles.contentError} data-testid="audit-spec-error">
                {audit.auditError}
              </div>
            )}
            {audit.auditState === 'ok' && (
              <div style={styles.markdownWrapper} data-testid="audit-spec-content">
                <MarkdownLite markdown={audit.auditContent} style={styles.markdown} />
                {/* reconcile-inline-feedback AC5: dezenter PR-Bezug (graceful absence) */}
                {audit.prReference && (
                  audit.prReference.url ? (
                    <a
                      href={audit.prReference.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.auditPrLink}
                      data-testid="audit-spec-pr-link"
                    >
                      {audit.prReference.label}
                    </a>
                  ) : (
                    <span style={styles.auditPrHint} data-testid="audit-spec-pr-hint">
                      {audit.prReference.label}
                    </span>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── ReconcileTrigger (reconcile-trigger AC1/AC2/AC4 + reconcile-inline-feedback AC1/AC4/AC5 + headless-reconcile-runner AC10–AC15) ──

/** Busy-guard poll interval in ms (GET /api/session, Fremd-Busy) — matches CockpitView/FactoryWorkspace default. */
const RECONCILE_SESSION_POLL_MS = 3_000;

/**
 * headless-reconcile-runner (S-208) AC13/Edge-Cases: bounded safety window
 * against an endless spinner — if the job poll (GET /api/reconcile/:jobId)
 * never reaches a terminal status (or fails repeatedly — e.g. 404 after a
 * server restart) within this window, the UI degrades to a neutral hint.
 */
const RECONCILE_SAFETY_WINDOW_MS = 5 * 60 * 1000; // 5 min

/** Max consecutive /api/reconcile/:jobId poll failures before degrading. */
const RECONCILE_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * ReconcileTrigger — „Konzept/Spec nachziehen"-Button
 * (reconcile-trigger AC1/AC2/AC4 + reconcile-inline-feedback AC1/AC4/AC5 +
 * headless-reconcile-runner AC10–AC15).
 *
 * Gespiegelt vom „Board abarbeiten"-Knopf (CockpitView.jsx FactoryWorkspace):
 * Bestätigungsdialog vor dem doku-ändernden Lauf, Busy-Guard via GET /api/session
 * (Fremd-Busy, z.B. Flow-/Board-Button — reconcile-trigger AC4, unverändert).
 *
 * headless-reconcile-runner (S-208): „Starten" POSTet jetzt an `/api/reconcile`
 * `{projectSlug}` (statt `/api/command`) und erhält `202 {jobId}` (AC10). Der
 * Lauf-Fortschritt wird über `GET /api/reconcile/:jobId` gepollt — **nicht**
 * mehr über `/api/session` (AC11, bewusste Ablösung der S-205-Poll-Quelle).
 * Der generische Busy-Guard-Poll (AC4, Fremd-Busy) bleibt als **separater**
 * Poll bestehen, weil der Headless-Runner vollständig vom CommandService/
 * PtyManager getrennt ist (Spec AC7 Backend) — `/api/session` wird durch einen
 * Reconcile-Job nicht mehr „busy".
 *
 * Job-Status `done` → „Fertig" (AC12), `onDone()` genau einmal (AuditSpecView-
 * Reload-Signal, reconcile-inline-feedback AC4). `failed` → inline Fehleranzeige
 * mit Reset (AC13). `auth-expired` → klarer Erneuerungs-Hinweis (AC14, kein
 * falsches „Fertig"). `409` beim Start (Projekt-Sperre des Headless-Runners) →
 * passender Hinweis (AC13).
 *
 * Robuste Degradierung (Timeout/Endlos-Spinner-Schutz, beibehalten aus
 * reconcile-inline-feedback AC8): `runStartRef` verankert den Start-Zeitpunkt
 * des eigenen Laufs; `consecutiveFailRef` zählt aufeinanderfolgende Job-Poll-
 * Fehler (Netzwerkfehler, nicht-ok Status inkl. 404 nach Server-Neustart, oder
 * ein unbekannter Status-Wert). Überschreitet die verstrichene Zeit das
 * Sicherheitsfenster ODER die Fehlerzahl den Schwellwert, während der Lauf noch
 * als „running" geführt wird, degradiert die Anzeige neutral (kein Endlos-
 * Spinner, kein Crash) — der separate „Audit-Spec anzeigen"-Button
 * (AuditSpecView) bleibt unabhängig davon manuell bedienbar.
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   onDone?: () => void,
 *   pollInterval?: number,
 *   safetyWindowMs?: number,
 *   maxConsecutiveFailures?: number,
 * }} props
 *   fetchFn                — injectable for tests (default: globalThis.fetch), AC15
 *   onDone                 — (AC12) aufgerufen genau einmal beim Übergang auf „Fertig"
 *   pollInterval           — Poll-Intervall in ms für BEIDE Polls (Busy-Guard `/api/session`
 *                            UND Job-Status `/api/reconcile/:jobId`; default: RECONCILE_SESSION_POLL_MS)
 *   safetyWindowMs         — Sicherheitsfenster für den Job-Poll in ms (default: RECONCILE_SAFETY_WINDOW_MS)
 *   maxConsecutiveFailures — max. aufeinanderfolgende Job-Poll-Fehler (default: RECONCILE_MAX_CONSECUTIVE_FAILURES)
 */
function ReconcileTrigger({
  projectSlug,
  fetchFn,
  onDone,
  pollInterval = RECONCILE_SESSION_POLL_MS,
  safetyWindowMs = RECONCILE_SAFETY_WINDOW_MS,
  maxConsecutiveFailures = RECONCILE_MAX_CONSECUTIVE_FAILURES,
}) {
  // Stable ref so the poll effects don't re-register on every render.
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // ── Fremd-Busy state (reconcile-trigger AC4, unverändert) ─────────────────
  /** 'idle' | 'running' — derived from GET /api/session state */
  const [sessionRunState, setSessionRunState] = useState('idle');

  // ── Trigger state (AC2 + headless-reconcile-runner AC10–AC14) ─────────────
  /** 'idle' | 'confirm' | 'starting' | 'running' | 'done' | 'failed' | 'auth-expired' | 'degraded' | 'error' */
  const [reconcileState, setReconcileState] = useState('idle');
  const [reconcileError, setReconcileError] = useState(null);

  const runStartRef = useRef(null);
  const consecutiveFailRef = useRef(0);
  /** headless-reconcile-runner AC10/AC11: jobId of the in-flight run (from POST /api/reconcile). */
  const jobIdRef = useRef(null);

  /** Transition helper. */
  const setPhase = useCallback((next) => {
    setReconcileState(next);
  }, []);

  /** End this trigger's own run, transitioning to a terminal phase. */
  const finishRun = useCallback((nextPhase) => {
    setPhase(nextPhase);
    runStartRef.current = null;
    consecutiveFailRef.current = 0;
    jobIdRef.current = null;
    if (nextPhase === 'done') {
      onDoneRef.current?.(); // AC12 — exactly once per completion
    }
  }, [setPhase]);

  // ── Poll /api/session — generic Fremd-Busy guard (reconcile-trigger AC4,
  // unverändert). Läuft unabhängig vom eigenen Reconcile-Job, weil der
  // Headless-Runner vollständig vom CommandService getrennt ist (Spec AC7). ──
  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      try {
        const res = await fetchFnRef.current('/api/session');
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json();
          if (cancelled) return;
          setSessionRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // Netzwerkfehler beim Busy-Guard-Poll — Zustand bleibt unverändert (kein Crash).
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  // ── Poll GET /api/reconcile/:jobId — Fertig-/Fehler-Quelle des eigenen Laufs
  // (headless-reconcile-runner AC11: Ablösung von /api/session als Fertig-Quelle). ──
  useEffect(() => {
    if (reconcileState !== 'running') return undefined;
    let cancelled = false;

    function maybeDegrade() {
      const elapsed = Date.now() - (runStartRef.current ?? Date.now());
      const timedOut = elapsed >= safetyWindowMs;
      const tooManyFailures = consecutiveFailRef.current >= maxConsecutiveFailures;
      if (timedOut || tooManyFailures) {
        // Robuste Degradierung — kein Endlos-Spinner, kein Crash.
        finishRun('degraded');
      }
    }

    async function pollJob() {
      const jobId = jobIdRef.current;
      if (!jobId) return;

      let res;
      try {
        res = await fetchFnRef.current(`/api/reconcile/${encodeURIComponent(jobId)}`);
      } catch {
        if (cancelled) return;
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }
      if (cancelled) return;

      // Edge-Case: 404 (unbekannte jobId, z.B. Server-Neustart — In-Memory-
      // Job-Registry geht verloren) zählt als Poll-Fehler, kein Crash.
      if (!res.ok) {
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }

      let json;
      try {
        json = await res.json();
      } catch {
        consecutiveFailRef.current += 1;
        maybeDegrade();
        return;
      }
      if (cancelled) return;

      consecutiveFailRef.current = 0;

      if (json.status === 'done') {
        // AC12: Übergang zu „Fertig".
        finishRun('done');
        return;
      }
      if (json.status === 'failed') {
        // AC13: inline Fehleranzeige mit Reset.
        setReconcileError(
          typeof json.error === 'string' && json.error.trim()
            ? json.error
            : 'Reconcile fehlgeschlagen.',
        );
        finishRun('failed');
        return;
      }
      if (json.status === 'auth-expired') {
        // AC14: klarer Erneuerungs-Hinweis, kein falsches „Fertig".
        finishRun('auth-expired');
        return;
      }
      if (json.status === 'running') {
        // Weiter im Lauf-Zustand — Sicherheitsfenster trotzdem prüfen (Timeout-
        // Schutz, falls der Job nie einen Endzustand erreicht).
        maybeDegrade();
        return;
      }
      // Unbekannter Status — defensiv wie ein Poll-Fehler behandeln.
      consecutiveFailRef.current += 1;
      maybeDegrade();
    }

    pollJob();
    const timer = setInterval(pollJob, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [reconcileState, pollInterval, safetyWindowMs, maxConsecutiveFailures, finishRun]);

  const isSessionBusy = sessionRunState === 'running';
  const isOwnRunActive = reconcileState === 'running';

  // AC1/AC4: button disabled when session busy, a start is in flight, or this
  // trigger's own run is active.
  const isBtnDisabled = isSessionBusy || reconcileState === 'starting' || isOwnRunActive;

  // Button remains visible (and re-enables) across idle/running/done/degraded —
  // hidden during 'starting' (POST-in-flight), 'error' (start-time failure),
  // 'failed' and 'auth-expired' (job-status terminal errors — replaced by the
  // alert + reset, AC13/AC14).
  const showButton = ['idle', 'running', 'done', 'degraded'].includes(reconcileState);

  const handleClick = useCallback(() => {
    setPhase('confirm');
    setReconcileError(null);
  }, [setPhase]);

  const handleCancel = useCallback(() => {
    setPhase('idle');
    setReconcileError(null);
  }, [setPhase]);

  const handleConfirm = useCallback(async () => {
    setPhase('starting');
    setReconcileError(null);

    // AC10: POST /api/reconcile {projectSlug} (statt /api/command).
    const body = { projectSlug };

    let res;
    try {
      res = await fetchFnRef.current('/api/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Netzwerkfehler → sichtbare Fehleranzeige, kein onNavigate.
      setPhase('error');
      setReconcileError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // AC10: bleibt auf dem Reiter — kein onNavigate. Inline „Reconcile läuft…".
      let json;
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      jobIdRef.current = typeof json.jobId === 'string' ? json.jobId : null;
      runStartRef.current = Date.now();
      consecutiveFailRef.current = 0;
      setPhase('running');
      return;
    }
    if (res.status === 409) {
      // AC13: Headless-Runner-Projekt-Sperre → passender Hinweis, kein Crash.
      setPhase('error');
      setReconcileError('Reconcile läuft bereits für dieses Projekt — bitte warten.');
      return;
    }
    if (res.status === 400) {
      // Edge-Case (Spec): fehlender/ungültiger Slug → sichtbare Fehleranzeige.
      setPhase('error');
      setReconcileError('Reconcile konnte nicht gestartet werden (ungültiges Projekt).');
      return;
    }
    // 500/unerwarteter Status → sichtbare Fehleranzeige, kein onNavigate.
    setPhase('error');
    setReconcileError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [projectSlug, setPhase]);

  return (
    <div style={styles.reconcileBox} data-testid="reconcile-box">
      <div style={styles.reconcileHeader}>Konzept/Spec nachziehen</div>
      {/* AC1: Hinweistext nennt den ausgelösten Befehl */}
      <p style={styles.reconcileHint}>
        Startet <code style={styles.code}>/agent-flow:reconcile</code> — gleicht
        Konzept, Architektur und Specs wieder mit Vorlage und Code ab.
      </p>

      {showButton && (
        <button
          type="button"
          style={isBtnDisabled ? styles.btnReconcileDisabled : styles.btnReconcile}
          disabled={isBtnDisabled}
          aria-disabled={isBtnDisabled}
          onClick={isBtnDisabled ? undefined : handleClick}
          aria-label={
            isOwnRunActive
              ? 'Konzept/Spec nachziehen — läuft'
              : isSessionBusy
              ? 'Konzept/Spec nachziehen — gesperrt (Job läuft)'
              : 'Konzept/Spec nachziehen starten — öffnet Bestätigungsdialog'
          }
          data-testid="reconcile-btn"
        >
          {isOwnRunActive
            ? 'Konzept/Spec nachziehen — läuft'
            : isSessionBusy
            ? 'Konzept/Spec nachziehen — gesperrt'
            : 'Konzept/Spec nachziehen'}
        </button>
      )}

      {/* AC4 (reconcile-trigger): Lock-Hinweis für Fremd-Busy (Text, nicht nur Farbe) */}
      {isSessionBusy && !isOwnRunActive && reconcileState === 'idle' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileLockNotice}
          data-testid="reconcile-lock-notice"
        >
          Ein Job läuft — Trigger gesperrt.
        </div>
      )}

      {/* headless-reconcile-runner AC10/AC11: eigener Lauf aktiv */}
      {reconcileState === 'running' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-running"
        >
          Reconcile läuft…
        </div>
      )}

      {/* headless-reconcile-runner AC12: eigener Lauf abgeschlossen */}
      {reconcileState === 'done' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-done"
        >
          Fertig
        </div>
      )}

      {/* headless-reconcile-runner AC13: Job-Status "failed" → Fehleranzeige mit Reset */}
      {reconcileState === 'failed' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="reconcile-job-failed">
          {reconcileError}
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => setPhase('idle')}
            aria-label="Fehlerstatus zurücksetzen"
            data-testid="reconcile-job-failed-reset"
          >
            Zurücksetzen
          </button>
        </div>
      )}

      {/* headless-reconcile-runner AC14: Job-Status "auth-expired" → klarer Erneuerungs-Hinweis */}
      {reconcileState === 'auth-expired' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="reconcile-auth-expired">
          Claude-Anmeldung abgelaufen — Token via{' '}
          <code style={styles.code}>claude setup-token</code> erneuern.
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => setPhase('idle')}
            aria-label="Hinweis zurücksetzen"
            data-testid="reconcile-auth-expired-reset"
          >
            Zurücksetzen
          </button>
        </div>
      )}

      {/* reconcile-inline-feedback AC8 (Quelle jetzt Job-Poll): robuste Degradierung — kein Endlos-Spinner */}
      {reconcileState === 'degraded' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileDegraded}
          data-testid="reconcile-degraded"
        >
          Status unklar — bitte „Audit-Spec anzeigen" manuell aktualisieren.
        </div>
      )}

      {/* AC2: Bestätigungsdialog — verhindert versehentlichen Start */}
      {reconcileState === 'confirm' && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Konzept/Spec nachziehen bestätigen"
          style={styles.reconcileConfirmBox}
          data-testid="reconcile-confirm-dialog"
        >
          <p style={styles.reconcileConfirmText}>
            Startet einen Fabrik-Lauf, der die Doku (Konzept, Architektur, Specs)
            automatisch ändert/abgleicht. Fortfahren?
          </p>
          <div style={styles.reconcileConfirmBtns}>
            <button
              type="button"
              style={styles.btnReconcileConfirm}
              onClick={handleConfirm}
              aria-label="Bestätigen — Konzept/Spec nachziehen starten"
              data-testid="reconcile-confirm-yes"
            >
              Starten
            </button>
            <button
              type="button"
              style={styles.btnReconcileCancel}
              onClick={handleCancel}
              aria-label="Abbrechen — kein Start"
              data-testid="reconcile-confirm-no"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {reconcileState === 'starting' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="reconcile-starting"
        >
          Starte…
        </div>
      )}

      {/* headless-reconcile-runner AC13: Start-Fehler (409/400/500/Netzwerkfehler) */}
      {reconcileState === 'error' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="reconcile-error">
          {reconcileError}
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => setPhase('idle')}
            aria-label="Fehlerstatus zurücksetzen"
            data-testid="reconcile-error-reset"
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </div>
  );
}

// ── ObsidianSyncTrigger (obsidian-sync-trigger AC1–AC7) ──────────────────────

/** Busy-guard poll interval in ms (GET /api/session) — matches ReconcileTrigger default. */
const OBSIDIAN_SYNC_SESSION_POLL_MS = 3_000;

/**
 * ObsidianSyncTrigger — „Notizen-Stand abgleichen"-Button (Obsidian-Sync),
 * direkt unterhalb des Audit-Spec-Buttons (obsidian-sync-trigger AC1–AC7).
 * Gespiegelt vom ReconcileTrigger-Muster (Bestätigungsdialog,
 * Busy-Guard via `GET /api/session`, Fehler-/Reset-Handling) — POSTet aber
 * weiterhin **unverändert** über `POST /api/command` (kein Headless-Runner-
 * Umbau wie bei [[headless-reconcile-runner]] — diese Story ändert daran
 * nichts, s. Spec-Verträge).
 *
 * `<path>` (obsidian-sync-trigger AC3, löst Annahme A1): der Bestätigungs-
 * dialog lädt `GET /api/settings/obsidian-vault/projects`, sobald der Vault
 * als konfiguriert erkannt ist, und lässt den Nutzer den passenden Vault-
 * Projektordner explizit auswählen (kein persistiertes Projekt↔Ordner-
 * Mapping vorhanden — s. Spec „Offene Annahmen" A1-Präzisierung). „Starten"
 * bleibt deaktiviert, bis ein Ordner gewählt ist; eine leere/fehlerhafte
 * Ordner-Liste zeigt einen Fehlerhinweis im Dialog (Edge-Case „kann nicht
 * bestimmt werden", kein POST).
 *
 * AC6 — **Präzisierung (Iteration 2):** nach `202` wird `onShowArbeiten()`
 * aufgerufen (lokaler Tab-Wechsel in CockpitView), NICHT das generische
 * App-Level `onNavigate('factory')`. Live nachgewiesener Bug: `onNavigate`
 * ist `useHashRouter().navigate`, dessen `viewToHash('factory')` IMMER das
 * bare `#/factory` erzeugt (kein Repo-Segment) — von innerhalb des bereits
 * gemounteten Cockpits (`#/factory/<repo>`) aufgerufen, hätte das den
 * Projekt-Kontext verworfen und den Nutzer auf die Repo-Übersicht geworfen,
 * statt den Lauf live im Terminal zu zeigen. `onShowArbeiten` schaltet
 * stattdessen nur den internen `activeTab`-State von CockpitView um (Muster:
 * `openSpec`/`onShowBoard`).
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   onShowArbeiten?: () => void,
 *   pollInterval?: number,
 * }} props
 *   fetchFn        — injectable für Tests (default: globalThis.fetch)
 *   onShowArbeiten — (AC6) aufgerufen nach 202 — schaltet CockpitView auf den
 *                    „Arbeiten"-Reiter
 *   pollInterval   — Poll-Intervall in ms für den Busy-Guard-Poll (default:
 *                    OBSIDIAN_SYNC_SESSION_POLL_MS)
 */
function ObsidianSyncTrigger({
  projectSlug,
  fetchFn,
  onShowArbeiten,
  pollInterval = OBSIDIAN_SYNC_SESSION_POLL_MS,
}) {
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  const onShowArbeitenRef = useRef(onShowArbeiten);
  useEffect(() => {
    onShowArbeitenRef.current = onShowArbeiten;
  }, [onShowArbeiten]);

  // ── AC1: Vault-konfiguriert-Zustand ────────────────────────────────────────
  /** 'loading' | 'configured' | 'unconfigured' */
  const [vaultState, setVaultState] = useState('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchFnRef.current('/api/settings/obsidian-vault-path');
        if (cancelled) return;
        if (!res.ok) { setVaultState('unconfigured'); return; }
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        setVaultState(json?.configured ? 'configured' : 'unconfigured');
      } catch {
        if (!cancelled) setVaultState('unconfigured');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── AC3 (löst A1): Vault-Projektordner-Liste, sobald Vault konfiguriert ───
  /** 'idle' | 'loading' | 'ok' | 'empty' | 'error' */
  const [folderState, setFolderState] = useState('idle');
  const [folders, setFolders] = useState([]);
  const [selectedPath, setSelectedPath] = useState('');

  useEffect(() => {
    if (vaultState !== 'configured') return undefined;
    let cancelled = false;
    setFolderState('loading');
    (async () => {
      let res;
      try {
        res = await fetchFnRef.current('/api/settings/obsidian-vault/projects');
      } catch {
        if (!cancelled) setFolderState('error');
        return;
      }
      if (cancelled) return;
      if (!res.ok) { setFolderState('error'); return; }
      let json;
      try {
        json = await res.json();
      } catch {
        json = {};
      }
      if (cancelled) return;
      const list = Array.isArray(json?.projects) ? json.projects : [];
      if (list.length === 0) { setFolderState('empty'); return; }
      setFolders(list);
      setFolderState('ok');
    })();
    return () => { cancelled = true; };
  }, [vaultState]);

  // ── AC5: Fremd-Busy-Guard (GET /api/session, Polling-Muster wie ReconcileTrigger) ──
  /** 'idle' | 'running' */
  const [sessionRunState, setSessionRunState] = useState('idle');

  useEffect(() => {
    let cancelled = false;

    async function pollSession() {
      try {
        const res = await fetchFnRef.current('/api/session');
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json();
          if (cancelled) return;
          setSessionRunState(json.state === 'busy' ? 'running' : 'idle');
        }
      } catch {
        // Netzwerkfehler beim Busy-Guard-Poll — Zustand bleibt unverändert (kein Crash).
      }
    }

    pollSession();
    const timer = setInterval(pollSession, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollInterval]);

  // ── Trigger-Zustand (AC2/AC3/AC6/AC7) ──────────────────────────────────────
  /** 'idle' | 'confirm' | 'starting' | 'error' */
  const [phase, setPhase] = useState('idle');
  const [syncError, setSyncError] = useState(null);

  const isVaultConfigured = vaultState === 'configured';
  const isSessionBusy = sessionRunState === 'running';
  const isBtnDisabled = !isVaultConfigured || isSessionBusy || phase === 'starting';
  const showButton = phase === 'idle';

  const handleClick = useCallback(() => {
    if (isBtnDisabled) return; // AC5: Klick auf deaktivierten Button ist ein no-op
    setPhase('confirm');
    setSyncError(null);
  }, [isBtnDisabled]);

  const handleCancel = useCallback(() => {
    setPhase('idle');
    setSelectedPath('');
    setSyncError(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!selectedPath) return; // Starten ist ohne Auswahl deaktiviert (Guard bleibt defensiv)
    setPhase('starting');
    setSyncError(null);

    const body = {
      command: `/agent-flow:from-notes --sync ${selectedPath}`,
      ...(projectSlug ? { projectPath: projectSlug } : {}),
    };

    let res;
    try {
      res = await fetchFnRef.current('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setPhase('error');
      setSyncError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }

    if (res.status === 202) {
      // AC6: kein stehengebliebenes Element — zurück auf idle, dann Tab-Wechsel.
      setSelectedPath('');
      setPhase('idle');
      onShowArbeitenRef.current?.();
      return;
    }
    if (res.status === 409) {
      setPhase('error');
      setSyncError('Ein Job läuft bereits — bitte warten.');
      return;
    }
    if (res.status === 400) {
      setPhase('error');
      setSyncError('Abgleich konnte nicht gestartet werden (ungültige Anfrage).');
      return;
    }
    setPhase('error');
    setSyncError(`Fehler beim Starten (HTTP ${res.status}).`);
  }, [selectedPath, projectSlug]);

  return (
    <div style={styles.reconcileBox} data-testid="obsidian-sync-box">
      <div style={styles.reconcileHeader}>Notizen-Stand abgleichen</div>
      {/* AC1: Hinweistext nennt den Befehl und stellt „kein Blind-Overwrite" klar */}
      <p style={styles.reconcileHint}>
        Startet <code style={styles.code}>/agent-flow:from-notes --sync</code> —
        zeigt Widersprüche zwischen Notizen und Konzept/Spec an, überschreibt
        nicht blind.
      </p>

      {showButton && (
        <button
          type="button"
          style={isBtnDisabled ? styles.btnReconcileDisabled : styles.btnReconcile}
          disabled={isBtnDisabled}
          aria-disabled={isBtnDisabled}
          onClick={handleClick}
          aria-label={
            isSessionBusy
              ? 'Notizen-Stand abgleichen — gesperrt (Job läuft)'
              : !isVaultConfigured
              ? 'Notizen-Stand abgleichen — kein Vault konfiguriert'
              : 'Notizen-Stand abgleichen starten — öffnet Bestätigungsdialog'
          }
          data-testid="obsidian-sync-btn"
        >
          Notizen-Stand abgleichen
        </button>
      )}

      {/* AC1: Text-Hinweis, wenn kein Vault konfiguriert (nicht nur Farbe) */}
      {showButton && !isVaultConfigured && !isSessionBusy && (
        <div style={styles.reconcileLockNotice} data-testid="obsidian-sync-vault-hint">
          Kein Obsidian-Vault konfiguriert — zuerst in den Einstellungen setzen.
        </div>
      )}

      {/* AC5: Lock-Hinweis für Fremd-Busy (Text, nicht nur Farbe) */}
      {showButton && isSessionBusy && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileLockNotice}
          data-testid="obsidian-sync-lock-notice"
        >
          Ein Job läuft — Trigger gesperrt.
        </div>
      )}

      {/* AC2/AC3: Bestätigungsdialog — verhindert versehentlichen Start,
          enthält die Ordner-Auswahl (löst A1). */}
      {phase === 'confirm' && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label="Notizen-Stand abgleichen bestätigen"
          style={styles.reconcileConfirmBox}
          data-testid="obsidian-sync-confirm-dialog"
        >
          <p style={styles.reconcileConfirmText}>
            Startet einen Abgleich-Lauf: Widersprüche zwischen Notizen und
            Konzept/Spec werden angezeigt — nichts wird blind überschrieben.
          </p>

          {folderState === 'loading' && (
            <div
              role="status"
              aria-live="polite"
              style={styles.reconcileHint}
              data-testid="obsidian-sync-folders-loading"
            >
              Lade Vault-Projektordner…
            </div>
          )}
          {folderState === 'empty' && (
            <div role="alert" style={styles.reconcileStatusError} data-testid="obsidian-sync-folders-empty">
              Kein Vault-Projektordner gefunden — Abgleich kann nicht gestartet werden.
            </div>
          )}
          {folderState === 'error' && (
            <div role="alert" style={styles.reconcileStatusError} data-testid="obsidian-sync-folders-error">
              Vault-Projektordner konnten nicht geladen werden — Abgleich kann nicht gestartet werden.
            </div>
          )}
          {folderState === 'ok' && (
            <div style={styles.obsidianFolderField}>
              <label htmlFor="obsidian-sync-folder-select" style={styles.reconcileHint}>
                Vault-Projektordner
              </label>
              <select
                id="obsidian-sync-folder-select"
                value={selectedPath}
                onChange={(e) => setSelectedPath(e.target.value)}
                style={styles.obsidianFolderSelect}
                data-testid="obsidian-sync-folder-select"
              >
                <option value="">— auswählen —</option>
                {folders.map((f) => (
                  <option key={f.path} value={f.path}>{f.name}</option>
                ))}
              </select>
            </div>
          )}

          <div style={styles.reconcileConfirmBtns}>
            <button
              type="button"
              style={selectedPath ? styles.btnReconcileConfirm : styles.btnReconcileDisabled}
              disabled={!selectedPath}
              aria-disabled={!selectedPath}
              onClick={handleConfirm}
              aria-label="Bestätigen — Notizen-Stand abgleichen starten"
              data-testid="obsidian-sync-confirm-yes"
            >
              Starten
            </button>
            <button
              type="button"
              style={styles.btnReconcileCancel}
              onClick={handleCancel}
              aria-label="Abbrechen — kein Start"
              data-testid="obsidian-sync-confirm-no"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {phase === 'starting' && (
        <div
          role="status"
          aria-live="polite"
          style={styles.reconcileStatus}
          data-testid="obsidian-sync-starting"
        >
          Starte…
        </div>
      )}

      {/* AC7: 409/400/500/Netzwerkfehler → Fehleranzeige mit Reset */}
      {phase === 'error' && (
        <div role="alert" style={styles.reconcileStatusError} data-testid="obsidian-sync-error">
          {syncError}
          <button
            type="button"
            style={styles.btnReconcileReset}
            onClick={() => { setPhase('idle'); setSyncError(null); }}
            aria-label="Fehlerstatus zurücksetzen"
            data-testid="obsidian-sync-error-reset"
          >
            Zurücksetzen
          </button>
        </div>
      )}
    </div>
  );
}

// ── AuditSpecView (spec-audit-view AC1–AC4 + reconcile-inline-feedback AC4/AC5) ──

/**
 * PR-URL-Muster: `.../pull/<n>[...]` (GitHub-Pull-Request-Link).
 * Bare-Hash-Muster: `#<n>` (nicht gefolgt von einem weiteren Wortzeichen —
 * schließt z.B. `#123abc` als Nicht-Treffer aus).
 */
const PR_URL_RE = /https?:\/\/\S*\/pull\/(\d+)\S*/i;
const PR_HASH_RE = /#(\d+)(?!\w)/;

/**
 * Sucht im geladenen Audit-Markdown nach einem erkennbaren PR-Bezug
 * (reconcile-inline-feedback AC5, best-effort/SHOULD).
 *
 * @param {string} markdown
 * @returns {{ url: string|null, label: string }|null}
 */
function extractPrReference(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const urlMatch = markdown.match(PR_URL_RE);
  if (urlMatch) {
    return { url: urlMatch[0], label: `PR #${urlMatch[1]}` };
  }
  const hashMatch = markdown.match(PR_HASH_RE);
  if (hashMatch) {
    return { url: null, label: `PR #${hashMatch[1]}` };
  }
  return null;
}

/**
 * useAuditSpec — Lade-/Fetch-Zustandsmaschine für das Audit-Logbuch
 * (`docs/spec-audit.md`), gelöst aus der (jetzt rein präsentationalen)
 * `AuditSpecButton`-Komponente heraus (audit-spec-main-pane / S-210), damit
 * SpecView die Zustände in der Haupt-Inhaltsfläche rendern kann, während der
 * Button in der Sidebar bleibt (spec-audit-view AC1–AC4).
 *
 * Klick lädt `docs/spec-audit.md` des aktiven Projekts über die bestehende
 * Doku-Lese-API. 404 (kein Reconcile-Lauf) → freundlicher Hinweis statt
 * Fehleranzeige. Netzwerkfehler oder unerwarteter Status → sichtbare,
 * neutrale Fehleranzeige. Ein `requestId`-Zähler stellt sicher, dass bei
 * überlappenden Anfragen nur die zuletzt gestartete Antwort den State setzt
 * („letzte Ladung gewinnt"); ein synchroner `loadingRef`-Flag (statt eines
 * State-Reads) verhindert, dass mehrere synchron aufeinanderfolgende Klicks
 * (Doppelklick, bevor React den `disabled`-State neu gerendert hat) einen
 * zweiten konkurrierenden Request auslösen.
 *
 * reconcile-inline-feedback (S-205):
 * AC4 — `reloadSignal` (ein monoton hochgezählter Zähler von SpecView, bei
 *        jedem Reconcile-Abschluss +1) triggert programmatisch genau EIN
 *        `load()` — derselbe Lade-Pfad wie der manuelle Klick, inkl.
 *        `hasProjectSlug`-Guard (Edge-Case „Kein projectSlug") und
 *        Doppelklick-/Doppel-Reload-Guard (`loadingRef`). Der `lastReloadSignalRef`
 *        vergleicht gegen den beim Mount erfassten Startwert, damit der
 *        Effect NICHT beim initialen Mount feuert (nur bei einer echten
 *        Änderung, d.h. einem tatsächlichen Reconcile-Abschluss).
 * AC5 — erkennbarer PR-Bezug im geladenen Inhalt (PR-URL oder `#<nummer>`)
 *        → dezenter Link (echte URL, `target="_blank" rel="noopener noreferrer"`)
 *        bzw. reiner Text-Hinweis (Bare-Hash ohne Domain); sonst kein Element
 *        (graceful absence, kein Platzhalter, kein Crash).
 *
 * audit-spec-main-pane (S-210) AC5 — `onAutoReload` wird aufgerufen, BEVOR der
 * automatische Reload seinen Request feuert (nicht bei manuellen Klicks), damit
 * SpecView entscheiden kann, ob die Hauptfläche auf `audit` umschaltet (Edge-
 * Case: nicht, wenn dort gerade aktiv ein Navigations-Dokument gezeigt wird).
 *
 * @param {{
 *   projectSlug: string,
 *   fetchFn?: Function,
 *   reloadSignal?: number,
 *   onAutoReload?: () => void,
 * }} params
 *   fetchFn      — injectable für Tests (default: globalThis.fetch), analog zum
 *                  ReconcileTrigger.
 *   reloadSignal — (S-205 AC4) monoton hochgezählter Zähler; jede Änderung ab
 *                  dem Mount-Wert löst genau einen automatischen Reload aus.
 *   onAutoReload — (S-210 AC5) Callback vor einem automatischen (nicht
 *                  manuellen) Reload.
 */
function useAuditSpec({ projectSlug, fetchFn, reloadSignal, onAutoReload }) {
  const fetchFnRef = useRef(fetchFn ?? globalThis.fetch.bind(globalThis));
  useEffect(() => {
    fetchFnRef.current = fetchFn ?? globalThis.fetch.bind(globalThis);
  }, [fetchFn]);

  /** 'idle' | 'loading' | 'ok' | 'notfound' | 'error' */
  const [auditState, setAuditState] = useState('idle');
  const [auditContent, setAuditContent] = useState('');
  const [auditError, setAuditError] = useState('');

  // Monotonic request id — guards against overlapping loads (double-click,
  // repeat click while a previous request is still in flight).
  const requestIdRef = useRef(0);
  // Synchronous in-flight flag — checked BEFORE any `await`, so two
  // `fireEvent.click()` calls fired back-to-back in the same synchronous
  // event-handler batch (before React re-renders the `disabled` attribute)
  // still only start one request.
  const loadingRef = useRef(false);

  const hasProjectSlug = typeof projectSlug === 'string' && projectSlug.trim().length > 0;
  const isBtnDisabled = !hasProjectSlug || auditState === 'loading';

  const load = useCallback(async () => {
    // Edge-case: fehlender projectSlug → kein Request mit leerem Slug
    // (gilt für Klick UND automatischen Reload, S-205 Edge-Cases).
    if (!hasProjectSlug) return;
    // Doppelklick-/Doppel-Reload-Guard: nur eine aktive Ladung (synchron geprüft).
    if (loadingRef.current) return;
    loadingRef.current = true;

    const myRequestId = ++requestIdRef.current;
    setAuditState('loading');
    setAuditError('');

    const url = `/api/board/projects/${encodeURIComponent(projectSlug)}/docs/raw?path=${encodeURIComponent('docs/spec-audit.md')}`;

    let res;
    try {
      res = await fetchFnRef.current(url);
    } catch {
      loadingRef.current = false;
      if (requestIdRef.current !== myRequestId) return; // stale — a newer load already won
      setAuditState('error');
      setAuditError('Netzwerkfehler — bitte erneut versuchen.');
      return;
    }
    loadingRef.current = false;
    if (requestIdRef.current !== myRequestId) return; // stale

    if (res.status === 404) {
      // AC3: freundlicher Hinweis statt roher Fehlermeldung.
      setAuditState('notfound');
      return;
    }
    if (!res.ok) {
      // AC4: 500/unerwarteter Status → sichtbare, neutrale Fehleranzeige.
      setAuditState('error');
      setAuditError(`Fehler beim Laden (HTTP ${res.status}).`);
      return;
    }

    const text = await res.text();
    if (requestIdRef.current !== myRequestId) return; // stale
    setAuditContent(text);
    setAuditState('ok');
  }, [projectSlug, hasProjectSlug]);

  // reconcile-inline-feedback (S-205) AC4: automatischer Reload nach Reconcile-
  // Abschluss. Der Ref erfasst den Startwert beim Mount, damit der Effect NICHT
  // beim initialen Mount feuert — nur bei einer echten Änderung (= Abschluss).
  const lastReloadSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === undefined || reloadSignal === null) return;
    if (reloadSignal === lastReloadSignalRef.current) return; // kein neuer Abschluss
    lastReloadSignalRef.current = reloadSignal;
    onAutoReload?.();
    load();
  }, [reloadSignal, load, onAutoReload]);

  // AC5: PR-Bezug aus dem geladenen Inhalt (best-effort, nur wenn geladen).
  const prReference = useMemo(() => {
    if (auditState !== 'ok') return null;
    return extractPrReference(auditContent);
  }, [auditState, auditContent]);

  return { auditState, auditContent, auditError, prReference, load, isBtnDisabled };
}

/**
 * AuditSpecButton — „Audit-Spec anzeigen"-Sekundär-Button, direkt unterhalb
 * des ReconcileTrigger-Buttons (spec-audit-view AC1; Position/Label/Touch-
 * Target unverändert). Rein präsentational — die Lade-/Render-Zustände
 * rendert SpecView jetzt in der Haupt-Inhaltsfläche statt hier
 * (audit-spec-main-pane / S-210 AC1).
 *
 * @param {{ disabled: boolean, onClick: () => void }} props
 */
function AuditSpecButton({ disabled, onClick }) {
  return (
    <div style={styles.auditBox} data-testid="audit-spec-box">
      <button
        type="button"
        style={disabled ? styles.btnAuditSpecDisabled : styles.btnAuditSpec}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={disabled ? undefined : onClick}
        aria-label="Audit-Spec anzeigen — zeigt die letzten Reconcile-Aktionen"
        data-testid="audit-spec-btn"
      >
        Audit-Spec anzeigen
      </button>
    </div>
  );
}

// ── NavGroup ──────────────────────────────────────────────────────────────────

/**
 * Eine Gruppe von Navigations-Einträgen einer Schicht.
 *
 * @param {{
 *   label: string,
 *   entries: Array<{ path: string, title: string, type: string, status: string|null }>,
 *   activePath: string|null,
 *   onSelect: (path: string) => void,
 * }} props
 */
function NavGroup({ label, entries, activePath, onSelect }) {
  return (
    <div style={styles.navGroup}>
      <div style={styles.navGroupLabel} aria-hidden="true">{label}</div>
      {entries.map((entry) => (
        <button
          key={entry.path}
          type="button"
          style={{
            ...styles.navBtn,
            ...(activePath === entry.path ? styles.navBtnActive : {}),
          }}
          aria-current={activePath === entry.path ? 'page' : undefined}
          onClick={() => onSelect(entry.path)}
          title={entry.path}
        >
          <span style={styles.navBtnTitle}>{entry.title}</span>
          {entry.type === 'spec' && entry.status && (
            <span
              style={{
                ...styles.statusChip,
                ...(STATUS_CHIP_STYLES[entry.status] ?? STATUS_CHIP_STYLES._default),
              }}
              aria-label={`Status: ${entry.status}`}
            >
              {entry.status}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── SpecFilterBar (AC6) ───────────────────────────────────────────────────────

/**
 * Filter-Leiste: Doku-Typ (Mehrfachauswahl) + Spec-Status (Mehrfachauswahl).
 * Konsistent zum Board-Filter-Muster (Checkbox-Gruppen, kein Dropdown).
 *
 * @param {{
 *   filterTypes: Set<string>,
 *   filterStatuses: Set<string>,
 *   onToggleType: (type: string) => void,
 *   onToggleStatus: (status: string) => void,
 * }} props
 */
function SpecFilterBar({ filterTypes, filterStatuses, onToggleType, onToggleStatus }) {
  return (
    <div style={styles.filterBar} role="search" aria-label="Doku-Filter">
      {/* Typ-Filter */}
      <fieldset style={styles.filterFieldset}>
        <legend style={styles.filterLegend}>Typ</legend>
        <div style={styles.filterCheckboxRow}>
          {ALL_DOC_TYPES.map((type) => {
            const checked = filterTypes.has(type);
            const id = `spec-filter-type-${type}`;
            return (
              <label key={type} style={styles.filterCheckboxLabel} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleType(type)}
                  aria-label={`Typ ${TYPE_LABELS[type]} ${checked ? 'aktiv' : 'inaktiv'}`}
                  style={styles.filterCheckbox}
                />
                {TYPE_LABELS[type]}
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* Status-Filter (nur relevant für Specs) */}
      <fieldset style={styles.filterFieldset}>
        <legend style={styles.filterLegend}>Spec-Status</legend>
        <div style={styles.filterCheckboxRow}>
          {ALL_SPEC_STATUSES.map((status) => {
            const checked = filterStatuses.has(status);
            const id = `spec-filter-status-${status}`;
            return (
              <label key={status} style={styles.filterCheckboxLabel} htmlFor={id}>
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleStatus(status)}
                  aria-label={`Spec-Status ${status} ${checked ? 'aktiv' : 'inaktiv'}`}
                  style={styles.filterCheckbox}
                />
                {status}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

// ── Status-Chip-Styles ─────────────────────────────────────────────────────────

const STATUS_CHIP_STYLES = {
  draft:      { background: '#1e293b', color: '#93c5fd', borderColor: '#334155' },
  active:     { background: '#1a2a1a', color: '#86efac', borderColor: '#14532d' },
  superseded: { background: '#2a2a2a', color: '#6b7280', borderColor: '#374151' },
  _default:   { background: '#2a2a2a', color: '#9ca3af', borderColor: '#4b5563' },
};

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  container: {
    display: 'grid',
    gridTemplateColumns: '260px minmax(0, 1fr)',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },

  sidebar: {
    display: 'flex',
    flexDirection: 'column',
    borderRight: '1px solid #2a2a2a',
    background: '#111',
    overflowY: 'auto',
    minHeight: 0,
  },

  nav: {
    flex: 1,
    padding: '8px 0',
  },

  navGroup: {
    marginBottom: 4,
  },

  navGroupLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#4b5563',
    padding: '8px 14px 4px',
    textTransform: 'uppercase',
  },

  navBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    width: '100%',
    background: 'transparent',
    border: 'none',
    color: '#9ca3af',
    fontSize: 12,
    cursor: 'pointer',
    padding: '6px 14px',
    textAlign: 'left',
    minHeight: 44,
    borderRadius: 0,
    // Focus ring preserved (no outline:none)
  },

  navBtnActive: {
    background: '#1a2a3a',
    color: '#93c5fd',
  },

  navBtnTitle: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },

  navHint: {
    fontSize: 12,
    color: '#4b5563',
    padding: '16px 14px',
    fontStyle: 'italic',
  },

  navError: {
    fontSize: 12,
    color: '#f87171',
    padding: '12px 14px',
  },

  // ── Status-Chip in Navleiste ──
  statusChip: {
    fontSize: 9,
    padding: '1px 5px',
    borderRadius: 8,
    border: '1px solid',
    flexShrink: 0,
    fontWeight: 600,
    letterSpacing: '0.02em',
  },

  // ── Inhalt-Spalte ──
  content: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflowY: 'auto',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  contentHint: {
    fontSize: 14,
    color: '#4b5563',
    padding: '32px 24px',
    fontStyle: 'italic',
  },

  contentError: {
    fontSize: 13,
    color: '#f87171',
    padding: '16px 24px',
    background: '#2a1a1a',
    border: '1px solid #7f1d1d',
    margin: '16px 24px',
    borderRadius: 6,
  },

  markdownWrapper: {
    padding: '24px 32px',
    maxWidth: 860,
  },

  markdown: {
    fontSize: 14,
    lineHeight: 1.7,
    color: '#e5e7eb',
  },

  // ── Filter-Leiste (AC6) ──
  filterBar: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  filterFieldset: {
    border: 'none',
    margin: 0,
    padding: 0,
  },

  filterLegend: {
    fontSize: 10,
    fontWeight: 700,
    color: '#4b5563',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    marginBottom: 4,
  },

  filterCheckboxRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 10px',
  },

  filterCheckboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#9ca3af',
    cursor: 'pointer',
    minHeight: 44, // Touch-Target ≥ 44 px (WCAG 2.1 AA / design.md)
  },

  filterCheckbox: {
    accentColor: '#93c5fd',
    cursor: 'pointer',
  },

  // ── Reconcile-Trigger (reconcile-trigger AC1–AC7) ──
  reconcileBox: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  reconcileHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  reconcileHint: {
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

  btnReconcile: {
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

  // AC4: disabled state when session busy
  btnReconcileDisabled: {
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

  // AC4: lock notice text when session busy (supplements disabled button — not color alone)
  reconcileLockNotice: {
    fontSize: 11,
    color: '#fbbf24',
    fontStyle: 'italic',
  },

  reconcileConfirmBox: {
    background: '#111',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },

  reconcileConfirmText: {
    fontSize: 12,
    color: '#d1d5db',
    margin: 0,
    lineHeight: 1.5,
  },

  reconcileConfirmBtns: {
    display: 'flex',
    gap: 8,
  },

  btnReconcileConfirm: {
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

  btnReconcileCancel: {
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

  reconcileStatus: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  // reconcile-inline-feedback (S-205) AC8: neutrale Degradierung — kein Fehler-Look
  reconcileDegraded: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  reconcileStatusError: {
    fontSize: 12,
    color: '#f87171',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    alignItems: 'flex-start',
  },

  btnReconcileReset: {
    background: 'transparent',
    color: '#9ca3af',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    minHeight: 32,
  },

  // ── ObsidianSyncTrigger (obsidian-sync-trigger AC1–AC7) — Ordner-Auswahl im Dialog ──
  obsidianFolderField: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },

  obsidianFolderSelect: {
    background: '#1a1a1a',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 4,
    padding: '8px 10px',
    fontSize: 12,
    minHeight: 44,
  },

  // ── Audit-Spec-Button (spec-audit-view AC1–AC4) ──
  auditBox: {
    padding: '10px 12px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },

  btnAuditSpec: {
    alignSelf: 'flex-start',
    background: 'transparent',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    minHeight: 44,
    // Focus ring preserved (no outline:none)
  },

  btnAuditSpecDisabled: {
    alignSelf: 'flex-start',
    background: 'transparent',
    color: '#4b5563',
    border: '1px solid #262626',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'not-allowed',
    minHeight: 44,
  },

  // reconcile-inline-feedback (S-205) AC5: dezenter PR-Bezug
  auditPrLink: {
    display: 'inline-block',
    marginTop: 8,
    fontSize: 11,
    color: '#93c5fd',
    textDecoration: 'underline',
  },

  auditPrHint: {
    display: 'inline-block',
    marginTop: 8,
    fontSize: 11,
    color: '#6b7280',
    fontStyle: 'italic',
  },
};
