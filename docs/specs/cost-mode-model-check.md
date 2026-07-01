---
id: cost-mode-model-check
title: Automatische periodische Cost-Mode-Modellprüfung (Boot + Dispatch) mit Auto-Reparametrisierung via agent-flow-Curator
status: draft
version: 1
spec_format: use-case-2.0
---

# Spec: Automatische Cost-Mode-Modellprüfung  (`cost-mode-model-check`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Die Cost-Mode-Stufen (`low-cost | balanced | max-quality | frontier`, Token-Hebel) hängen an konkreten Modellen (z.B. `haiku/sonnet/opus/fable`). Diese Modelle ändern sich im Hintergrund laufend (z.B. Neuerscheinung „Sonnet 5"), und einzelne Modelle können **veralten** oder **nicht mehr auswählbar** sein (aktuell z.B. `Mythos`, `Fable` je nach Konto). dev-gui soll die Zuordnung **automatisch aktuell halten**: still im Hintergrund prüfen (beim Boot + periodisch + unmittelbar vor der Cost-Mode-Übergabe an einen Board-/Flow-Lauf), bei erkanntem Drift eine **kurze GUI-Meldung** zeigen, die **Reparametrisierung an den agent-flow-Curator delegieren** und danach eine **Vorher/Nachher-Übersicht** anzeigen — **ohne** den laufenden Vorgang auf Bestätigung warten zu lassen.

## Angenommene Interpretation / Scope-Abgrenzung (BINDEND — von `requirement` getroffen, 2026-07-01)

Diese Annahmen sind **normativ** für die ACs und schneiden das Feature auf die dev-gui-Boundary zu. Sie ersetzen die vagen Begriffe der rohen Anforderung.

- **A1 — „Defy" = „dev-gui".** Der Owner-Begriff „Defy" ist ein Diktier-/Spracherkennungs-Artefakt für **dev-gui** (den Namen dieser App). „Neustart von Defy" = **(Re)Start des dev-gui-Prozesses/-Containers** (always-on, ADR-002, `restart unless-stopped`). Es gibt keinen separaten Dienst „Defy". Alle „bei jedem Neustart"-Auslöser meinen den **dev-gui-Prozess-Boot** im bestehenden always-on-Prozess (kein neuer Dienst — ADR-006-Linie, Muster wie `ReconciliationJob`/`NightWatchScheduler`).

- **A2 — Die maßgebliche Cost-Mode→Modell-Matrix liegt NICHT in dev-gui, sondern in agent-flow.** Die autoritative Rolle×Modus→Modell-Matrix wird im agent-flow-Plugin gepflegt (`${CLAUDE_PLUGIN_ROOT}/knowledge/model-tiers.md`) und vom **Sondermodus `/train model-tiers`** kuratiert (agent-flow-Spec `docs/specs/model-tier-curator.md` — in einem **anderen** Repo, nicht hier). dev-gui besitzt davon **nur** die grobe, GUI-lokale Tier-Charakterisierung `client/src/costMode.js` (`COST_MODE_INFO`: grobe Modell-Namens-Strings + `$/MTok`, reine Anzeige-Orientierung) und injiziert das `--cost <mode>`-Flag ([[flow-trigger]] AC8/AC9). dev-gui **kennt** die maßgebliche Matrix nicht und **löst** keine Modelle auf.

- **A3 — Reparametrisierung + Modell-Auswahlbarkeits-Check sind agent-flow-seitig (AUSSERHALB dieser Spec).** Der eigentliche „welche Modelle sind angeboten UND auswählbar/nutzbar" (inkl. Ausschluss nicht-auswählbarer wie `Mythos`/`Fable`), die Suche nach den neuesten Modellen und das **Neu-Setzen** der Matrix leistet der agent-flow-Curator (`/train model-tiers`, `primary_sources` = Anthropic Models-Overview/Deprecations, `non_sources` ausgeschlossen). **Grund:** dev-gui hat **keine** Boundary/kein Recht, die agent-flow-`model-tiers.md` zu editieren, und **keinen** Live-Modell-Auswahlbarkeits-Endpunkt im Code (heute existiert kein Anthropic-Models-Listing in dev-gui). Diese Spec beschreibt daher **ausschließlich den dev-gui-seitigen Anteil**: *anstoßen* (headless), *melden* (GUI), *Vorher/Nachher zeigen* (aus dem Curator-Ergebnis). Der agent-flow-seitige Anteil (Curator-Logik, Auswahlbarkeits-Filter, Matrix-Schreibpfad) ist **explizit Out-of-scope** und ggf. ein **separater Vorgang im agent-flow-Plugin-Repo**.

- **A4 — Umsetzung = Mischform, an B angelehnt (headless Curator-Trigger + GUI-Meldung), NICHT dev-gui-lokale Matrix-Mutation (Alternative A verworfen).** dev-gui stößt bei Drift den Curator **headless** an (`claude -p '/agent-flow:train model-tiers'`, analog den bestehenden headless-Bausteinen (1)–(5) in `.claude/CLAUDE.md` + dem Muster [[reconcile-trigger]]/[[headless-reconcile-runner]]) und fasst dessen Vorher/Nachher-Ergebnis in Log/UI zusammen. **Alternative A** (dev-gui prüft/mutiert selbst die Modell-Zuordnung) ist **verworfen**: sie verletzte A2/A3 (dev-gui besäße die Matrix nicht, dürfte sie nicht editieren, hätte keinen Auswahlbarkeits-Check) und duplizierte die Curator-Logik.

- **A5 — Drift-Erkennung ist bewusst leichtgewichtig + delegierend.** dev-gui führt selbst **keinen** Anthropic-Modell-Auswahlbarkeits-Check aus (kein solcher Mechanismus in der dev-gui-Boundary — dokumentierte Limitation). Die **maßgebliche** „ist ein referenziertes Modell veraltet/nicht auswählbar?"-Entscheidung trifft der Curator-Lauf. dev-gui erkennt lediglich das **Frische-Signal** der Matrix (`last_curated`-Datum in `model-tiers.md`, Cooldown „max. 1×/Kalendermonat" — siehe Curator-Header) und/oder ein **Curator-Reparametrisierungs-Ergebnis „geändert"** und macht daraus die Meldung. Ist das Frische-Signal aktuell (innerhalb Cooldown) → **kein** Lauf, **keine** Meldung (Normalfall, still).

## Verhalten

### Auslöser 1 — Beim dev-gui-Boot (still, im Hintergrund)
1. Beim Prozess-Boot (im bestehenden always-on-Prozess, Muster `ReconciliationJob`/`NightWatchScheduler`) läuft **still im Hintergrund** eine `CostModeModelCheck`-Prüfung an. Sie liest das **Frische-Signal** der agent-flow-Matrix (`last_curated` aus `model-tiers.md` via read-only Plugin-Dateizugriff, analog `AgentFlowReader`) — **read-only**, blockiert den Boot nicht (fire-and-forget, degradierend: Plugin/Datei fehlt → Prüfung wird still übersprungen, kein Fehler, kein Crash).
2. **Normalfall (Signal frisch / innerhalb Cooldown):** keinerlei Meldung, keine Benutzerinteraktion (AC2-Analogon der Owner-ACs).
3. **Drift erkannt (Signal veraltet — außerhalb Cooldown, oder `never`/leer):** dev-gui zeigt eine **kurze Meldung** („ein referenziertes Modell könnte veraltet sein — Cost-Mode-Zuordnung wird aufgefrischt") und stößt den Curator **headless** an (Auslöser → V-Reparametrisierung).

### Auslöser 2 — Periodisch
4. Zusätzlich zum Boot läuft die Prüfung **periodisch** (konfigurierbares Intervall, Muster wie der Mitternachts-Tick von `ReconciliationJob`; Default z.B. 1×/Tag). Verhalten identisch zu Auslöser 1 (still bei frisch, Meldung + Curator-Trigger bei Drift).

### Auslöser 3 — Beim Board-/Flow-Dispatch (Cost-Mode-Übergabe an einen laufenden Vorgang)
5. Unmittelbar **bevor** dev-gui einen Cost-Mode an einen Board-/Flow-Lauf übergibt (der `--cost <mode>`-Pfad: manueller Headless-Drain [[headless-manual-drain]] AC3 **und** Nacht-Drain), läuft dieselbe leichtgewichtige Frische-Prüfung. Bei erkanntem Drift greift **dieselbe** Logik (kurze Meldung → Curator-Anstoß → Vorher/Nachher → automatische Fortsetzung, V-Reparametrisierung). Der Board-/Flow-Vorgang **läuft danach automatisch weiter, ohne auf Bestätigung zu warten** (nicht-blockierend; der Curator-Anstoß erfolgt asynchron/best-effort und blockiert den Drain-Start nicht).

### V — Reparametrisierung + Vorher/Nachher (delegiert an agent-flow)
6. **Kurze Meldung.** Bei Drift zeigt dev-gui eine **kurze, nicht-modale** Meldung („Modell veraltet — Cost-Mode-Zuordnung wird automatisch aufgefrischt"), die **niemanden** zum Bestätigen zwingt.
7. **Automatische Reparametrisierung (delegiert).** dev-gui stößt den agent-flow-Curator **headless** an: `claude -p '/agent-flow:train model-tiers'` als eigener Kindprozess (eigene `HeadlessFlowRunner`-Instanz + **eigene** `ProjectJobLock`-Instanz, getrennt von Nacht-Drain/Reconcile/Finalizer/manuellem Drain — Muster [[headless-reconcile-runner]]/[[headless-manual-drain]]). Der Curator sucht die neuesten auswählbaren Modelle und schreibt die neue Zuordnung (agent-flow-seitig, A3). dev-gui **mutiert die Matrix nicht selbst**.
8. **Vorher/Nachher-Übersicht.** Nach dem Curator-Lauf zeigt dev-gui eine **kurze Übersicht** „bisherige Zuordnung vs. neu parametrisierte Zuordnung" — gespeist aus dem Ergebnis des Curator-Laufs (die grobe GUI-lokale `COST_MODE_INFO` in `costMode.js` wird, falls der Curator eine geänderte Tier-Charakterisierung liefert, entsprechend aktualisiert/angezeigt; die maßgebliche Matrix bleibt in agent-flow). Ist der Curator-Lauf ohne Änderung („bereits aktuell") → Übersicht zeigt „keine Änderung", die vorher gezeigte „Modell veraltet"-Meldung wird zurückgenommen/aufgelöst.
9. **Nicht-blockierende Fortsetzung.** In **keinem** Auslöser-Pfad wartet dev-gui auf eine Bestätigung: Boot läuft weiter, periodischer Tick läuft weiter, der Board-/Flow-Vorgang startet/läuft weiter. Der Curator-Anstoß + die Übersicht sind **asynchron** und **best-effort**.

### Job-Status + Audit
10. Der Curator-Anstoß wird — wie die bestehenden headless-Bausteine — **auditiert** (Start/Ende/Fehler, keine Secrets/Token/absoluten Host-Pfade in Audit/Log/Response) und in einer **In-Memory-Job-Registry** geführt (`checkId → { status: 'running'|'done'|'failed', changed?: bool, before?, after? }`, Muster [[headless-reconcile-runner]]); ein Status-Endpunkt liefert „läuft / fertig / fehlgeschlagen" + das Vorher/Nachher-Ergebnis secret-/pfad-frei.

## Acceptance-Kriterien

- **AC1** (Boot-Prüfung, still) — Beim dev-gui-Prozess-Boot läuft im bestehenden always-on-Prozess (kein neuer Dienst) eine `CostModeModelCheck`-Prüfung **im Hintergrund** an, die das Frische-Signal der agent-flow-Matrix **read-only** liest; sie blockiert den Boot nicht und degradiert still (Plugin/Datei fehlt → übersprungen, kein Crash). *(1, A1, A5)*
- **AC2** (Normalfall = keinerlei Meldung) — Ist das Frische-Signal aktuell (innerhalb Cooldown), erfolgt **keinerlei** Meldung an den Nutzer und **kein** Curator-Anstoß (weder beim Boot, noch periodisch, noch beim Dispatch). *(2, 4, A5)*
- **AC3** (Drift → kurze Meldung + delegierte Reparametrisierung + Vorher/Nachher) — Ist das Frische-Signal veraltet (außerhalb Cooldown / `never` / leer) **oder** meldet ein Curator-Lauf eine Änderung, zeigt dev-gui eine **kurze, nicht-modale Meldung** („Modell veraltet"), stößt den agent-flow-Curator **headless** an (`claude -p '/agent-flow:train model-tiers'`, eigene Runner-/Lock-Instanz) und zeigt nach dem Lauf eine **Vorher/Nachher-Übersicht** (bisherige vs. neu parametrisierte Zuordnung); „keine Änderung" wird als solche angezeigt und die Meldung aufgelöst. dev-gui **mutiert die agent-flow-Matrix nicht selbst**. *(3, 6, 7, 8, A2, A3, A4)*
- **AC4** (Dispatch-Prüfung — dieselbe Logik) — Unmittelbar vor der Cost-Mode-Übergabe an einen Board-/Flow-Lauf ([[headless-manual-drain]]-Drain **und** Nacht-Drain) läuft dieselbe leichtgewichtige Frische-Prüfung; bei Drift greift **dieselbe** Meldung/Reparametrisierung/Übersicht wie AC3. *(5)*
- **AC5** (nicht-blockierende Fortsetzung) — In **keinem** Auslöser-Pfad wartet dev-gui auf eine manuelle Bestätigung: Boot, periodischer Tick und der Board-/Flow-Vorgang **laufen automatisch weiter**; der Curator-Anstoß + die Vorher/Nachher-Übersicht sind **asynchron/best-effort** und blockieren den Drain-Start nicht. *(5, 9)*
- **AC6** (nur auswählbare Modelle — delegiert + dokumentiert) — Die Beschränkung „nur tatsächlich angebotene UND auswählbare/nutzbare Modelle; nicht-auswählbare (z.B. `Mythos`, `Fable`) ausschließen" wird **im agent-flow-Curator** durchgesetzt (dessen `primary_sources`/Deprecations-Logik, A3), **nicht** in dev-gui: dev-gui besitzt keinen Live-Modell-Auswahlbarkeits-Check (dokumentierte Limitation, A5) und delegiert diese Auswahl vollständig an den angestoßenen Curator-Lauf. Diese Spec führt **keinen** eigenen Auswahlbarkeits-Filter in dev-gui ein. *(A3, A5)*
- **AC7** (Isolation + Audit + Job-Status) — Der Curator-Anstoß nutzt eine **eigene** `HeadlessFlowRunner`-Instanz mit **eigener** `ProjectJobLock`-Instanz (getrennt von Nacht-Drain/manuellem Drain/Reconcile/Finalizer — keine Selbst-/Fremdblockade), wird **auditiert** (Start/Ende/Fehler, keine Secrets/Token/absoluten Host-Pfade in Audit/Log/Response/WS) und in einer In-Memory-Job-Registry geführt; ein Status-Endpunkt liefert `{ status, changed?, before?, after? }` secret-/pfad-frei. *(10)*

## Verträge

### Endpunkte
- `GET /api/cost-mode/check/:checkId` → `200 { status: 'running'|'done'|'failed', changed?: boolean, before?: object, after?: object }` | `404` (unbekannte checkId). Secret-/pfad-frei; Format analog [[headless-reconcile-runner]]-Status. Registry-Verlust bei Server-Neustart ist Nicht-Ziel. *(AC7)*
- *(optional, falls das Panel einen manuellen Anstoß braucht)* `POST /api/cost-mode/check` → `202 { checkId }` | `409` (Curator-Lauf läuft bereits). Startet die Frische-Prüfung + ggf. den Curator-Anstoß headless. Der Boot-/periodische/Dispatch-Auslöser braucht diesen Endpunkt **nicht** (interner Tick).

### Wiederverwendung / Boundaries
- `CostModeModelCheck` *(neu — schmale dev-gui-Boundary)* — kapselt: (a) read-only Frische-Signal-Lesen der agent-flow-Matrix (via bestehendem `AgentFlowReader`-Muster, read-only Plugin-Dateizugriff), (b) Drift-Entscheidung (Frische/Cooldown, A5), (c) Anstoß des Curators über eine **eigene** `HeadlessFlowRunner`-Instanz, (d) Job-Registry + Vorher/Nachher-Ergebnis. **Kein** Schreibzugriff auf `model-tiers.md`.
- `HeadlessFlowRunner` / `HeadlessFlowRunnerAdapter` (`src/HeadlessFlowRunner.js`, `src/FlowRunner.js`) — bestehende Bausteine; **eigene** Instanz + **eigenes** `ProjectJobLock` (getrennt, wie [[headless-manual-drain]] AC2).
- Scheduler-Muster — `ReconciliationJob`/`NightWatchScheduler` (Boot-Anlauf + periodischer Tick im always-on-Prozess, ADR-002/ADR-013/ADR-015); **kein** neuer Dienst.
- `AgentFlowReader` (`src/AgentFlowReader.js`) — read-only Plugin-Dateizugriff (Muster für das Frische-Signal-Lesen von `model-tiers.md`).
- `costMode.js` (`client/src/costMode.js`) — die grobe GUI-lokale `COST_MODE_INFO`-Anzeige (Vorher/Nachher-Darstellung im Frontend); die **maßgebliche** Matrix bleibt in agent-flow (A2).
- `AuditStore` — Audit-First je Curator-Anstoß (AC7).

### Cross-Repo-Vertrag (SR)
- Die gesamte **Reparametrisierungs-Logik** (Modell-Suche, Auswahlbarkeits-Filter inkl. Ausschluss `Mythos`/`Fable`, Matrix-Schreibpfad) lebt in **agent-flow** (`docs/specs/model-tier-curator.md`, `knowledge/model-tiers.md`, `docs/architecture/model-tier-subsystem.md`). dev-gui injiziert nur die fertige Befehlszeile `/agent-flow:train model-tiers` (headless) und liest read-only das Frische-Signal + das Ergebnis. **Out-of-scope dieser Spec:** jede Änderung an der agent-flow-Curator-Logik oder der Matrix selbst (separater Vorgang im agent-flow-Repo, falls der Curator z.B. ein maschinenlesbares Vorher/Nachher-Ergebnis liefern soll — siehe Offene Fragen).

## Edge-Cases & Fehlerverhalten
- **agent-flow-Plugin / `model-tiers.md` fehlt** → Frische-Prüfung wird still übersprungen (degradierend, kein Crash, keine Meldung). *(AC1)*
- **Curator-Anstoß schlägt fehl** (`auth-expired`/Timeout/Fehler) → Job `failed`/auditiert, Lock im finally frei; UI zeigt „Auffrischen fehlgeschlagen" (nicht-blockierend). Der Board-/Flow-Vorgang läuft trotzdem weiter (AC5).
- **Curator läuft bereits** (Cooldown/Lock) → **kein** Doppel-Anstoß (`409` beim optionalen manuellen Endpunkt; interner Tick überspringt still).
- **Frische-Signal frisch, aber Nutzer vermutet Drift** → optionaler manueller `POST /api/cost-mode/check` erlaubt einen Anstoß mit `--force`-Semantik (delegiert an Curator-`--force`); ohne diesen Endpunkt: kein Lauf (still, AC2).
- **Server-Neustart während Curator-Lauf** → Job-Registry verloren (Nicht-Ziel); Subprozess ggf. verwaist (Timeout/OS bereinigt) — wie bei den bestehenden Runnern.
- **Kein Live-Terminal** für den Curator-Anstoß ist **erwartetes** Verhalten (headless), kein Fehler.

## NFRs
- **Sicherheit (Floor):** kein Anthropic-/OpenAI-API-Key in der Child-Env (harter Block, [[headless-parallel-drain]] AC1); argv als Array (kein Shell-Interpolation); keine Secrets/Token/absoluten Host-Pfade in Log/Audit/Response/WS. Der Frische-Signal-Lesepfad ist **read-only** (kein Schreiben in `model-tiers.md` aus dev-gui — Grep-prüfbar).
- **Isolation:** eigene `ProjectJobLock`-Instanz (keine Selbst-/Fremdblockade mit Nacht-Drain/manuellem Drain/Reconcile/Finalizer); importiert/mutiert **nicht** den `PtyManager`/interaktiven `CommandService`-Schreibpfad (Trust-Boundary).
- **Kosten:** der Curator-Lauf zählt gegen das Abo (`CLAUDE_CODE_OAUTH_TOKEN`, kein API-Key); die Prüfung läuft sparsam (nur bei Drift/außerhalb Cooldown), nicht bei jedem Tick teuer.
- **Nicht-Blockierung:** Boot/Tick/Dispatch werden nie durch die Prüfung oder den Curator-Anstoß aufgehalten (fire-and-forget/best-effort, AC5).
- **A11y (WCAG 2.1 AA):** die kurze Drift-Meldung + die Vorher/Nachher-Übersicht sind textlich (nicht nur Farbe), nicht-modal, mit sichtbarem Fokusring falls interaktiv; kein `dangerouslySetInnerHTML`, keine Secrets im Bundle.

## Nicht-Ziele
- **Keine** dev-gui-lokale Mutation der agent-flow-`model-tiers.md`-Matrix (liegt in agent-flow, A2/A3; Alternative A verworfen, A4).
- **Kein** eigener Live-Anthropic-Modell-Auswahlbarkeits-Check in dev-gui (kein solcher Mechanismus in der Boundary; delegiert an den Curator, A5/AC6).
- **Kein** eigener Auswahlbarkeits-Filter/`Mythos`/`Fable`-Ausschluss in dev-gui (agent-flow-seitig, AC6).
- **Kein** neuer Dienst — die Prüfung läuft im bestehenden always-on-Prozess (Muster `ReconciliationJob`/`NightWatchScheduler`).
- **Kein** blockierendes Bestätigungs-/Genehmigungs-Modal (nicht-blockierend, AC5; konsistent mit dem Nicht-Ziel „keine Mensch-im-Loop-Genehmigung pro Aktion", `concept.md`).
- **Keine** persistente Prüf-/Job-Historie (In-Memory, geht bei Neustart verloren).
- **Kein** echter `claude -p`-Live-Lauf im Test-Gate (gemockte `spawn`/Runner, [[headless-parallel-drain]] AC13).

## Offene Fragen (agent-flow-seitig — für einen separaten Vorgang im agent-flow-Repo)
1. **Maschinenlesbares Vorher/Nachher.** Damit dev-gui eine saubere „bisher vs. neu"-Übersicht zeigen kann, wäre ein strukturierter Curator-Ausgabe-Kanal (z.B. ein Diff-Block im Lauf-Ergebnis) hilfreich. Heute liest dev-gui das Frische-Signal + ggf. den Datei-Diff der Matrix read-only. Ob der Curator ein explizites Ergebnis-JSON liefern soll, ist eine agent-flow-Entscheidung (Out-of-scope hier).
2. **Direkter Auswahlbarkeits-Check.** Falls Anthropic später ein Models-Listing/Selectability-Signal anbietet, das dev-gui read-only konsumieren könnte, ließe sich die Drift-Erkennung von „Frische-Signal" auf „echte Modell-Verfügbarkeit" heben. Heute nicht verfügbar (A5).

## Abhängigkeiten
- [[flow-trigger]] (Cost-Mode-Enum + `--cost`-Injektion; dev-gui injiziert nur, die Matrix liegt in agent-flow — A2) · [[headless-manual-drain]] (Dispatch-Auslöser 3, Cost-Mode-Übergabe an den Drain; Runner-/Lock-Isolationsmuster) · [[headless-reconcile-runner]] (Runner-/Status-/Job-Registry-Muster) · [[headless-parallel-drain]] (`HeadlessFlowRunner`/`ProjectJobLock`/Timeout/Audit — Wiederverwendung) · [[team-train-trigger]] (`/agent-flow:train`-Auslöser-Muster; **hier** aber der Sondermodus `model-tiers`, den [[team-train-trigger]] bewusst NICHT exponiert) · `AgentFlowReader` (read-only Plugin-Datei-Lesen).
- **agent-flow (Cross-Repo, SR):** `docs/specs/model-tier-curator.md`, `knowledge/model-tiers.md`, `docs/architecture/model-tier-subsystem.md` — liefern die Reparametrisierungs-Logik + den Auswahlbarkeits-Filter. **Out-of-scope dieser Spec.**
