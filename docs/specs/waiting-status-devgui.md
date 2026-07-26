---
id: waiting-status-devgui
title: Warte-Status „Waiting" (extern gated) — dev-gui-Anteil (Drain-Toleranz + ruhige Board-Kategorie)
status: active
area: nachtwaechter
version: 1
spec_format: use-case-2.0
---

# Spec: Warte-Status „Waiting" — dev-gui-Anteil  (`waiting-status-devgui`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Extern gewartete Storys (z.B. „wartet auf den nächsten realen `/adopt`-Fall") werden heute mangels passendem Status als **`Blocked`** geführt — ein Missbrauch, der sie in der Dauer-Blocker-Optik der GUI festnagelt und die Blocked-Analyse verwässert. Es entsteht der neue, ruhige Board-Status **`Waiting`** (mit `wait_reason`). Die **Status-Definition selbst** (Board-Schema `status: Waiting` + Feld `wait_reason`, Konvention, Migration `Blocked → Waiting`) wird **separat im agent-flow-Repo** spezifiziert und hier **nur referenziert** — sie ist **nicht** Teil dieser Spec. Diese Spec deckt ausschließlich den **dev-gui-Anteil** ab: (a) `BoardAggregator`/`computeDrainState` behandeln `Waiting` wie `Blocked`/`Idee` (nie Drain-Ziel, keine gebrochene Lebendig-/Blocker-Analyse), **tolerant**, falls der Status noch nirgends vorkommt; (b) die Board-Ansichten zeigen `Waiting`-Storys als **eigene, ruhige Kategorie** „Wartet (extern)" statt in der `Blocked`-Optik; (c) der Nachtwächter-Vorab-Skip ([[nightwatch-idle-skip]]) zählt `Waiting` **nicht** als Ziel.

## Verhalten

1. **Rein additiv, kein Regress.** `Waiting` ist ein neuer Status neben `Idee`/`To Do`/`In Progress`/`Done`/`Blocked`. Kommt er im Board (noch) **nicht** vor, ändert sich **nichts** am bestehenden Verhalten (Bestandsschutz). Der dev-gui-Anteil ist tolerant, falls das Schema-Feld `wait_reason` (oder der Status) noch nicht überall gesetzt ist.
2. **Kein Drain-Ziel.** `computeDrainState` (`ProjectDrain.js`) und `computeStoryReadyStatus` (`BoardAggregator.js`) behandeln eine Story mit `status: Waiting` wie `Blocked`/`Idee`: **nie** in `targets` (kein ready-`To Do`, kein verwaistes `In Progress`), **nie** `couldBecomeReady`, **nie** eskaliert. Das ergibt sich strukturell daraus, dass nur ein `To Do` ready/`couldBecomeReady` werden kann — diese Spec macht es **explizit + testbar**, ohne die Ziel-Logik zu duplizieren ([[taktgeber-nachtwaechter]] AC1/AC3, maßgeblich).
3. **Robuste Lebendig-/Blocker-/depends-Analyse.** `computeAliveStoryIds` und die `depends`-Auflösung dürfen an einer `Waiting`-Story **nicht** brechen: eine `Waiting`-Story ist ein valider Board-Eintrag, aber **nie „lebendig"** (wie `Blocked`/`Idee`); eine `depends`-Referenz **auf** eine `Waiting`-Story gilt als **nicht erfüllter** (nicht-`Done`) Vorgänger — kein Crash, kein fälschliches `ready`, keine Endlosschleife.
4. **Ruhige Board-Kategorie (Frontend).** Board-Ansichten zeigen `Waiting`-Storys als **eigene, ruhige Kategorie** „**Wartet (extern)**" — visuell **getrennt** von der `Blocked`-Dauer-Blocker-Optik — mit `wait_reason` als sichtbarem **Text/Tooltip**. Status/Grund **textlich** (nicht nur farblich); fehlt `wait_reason`, ein dezenter Default-Text. Die bestehenden Kategorien (`To Do`/`In Progress`/`Done`/`Blocked`/`Idee`) bleiben unverändert.
5. **Vorab-Skip-Kohärenz.** Der Nachtwächter-Vorab-Skip ([[nightwatch-idle-skip]] AC1) zählt eine `Waiting`-Story **nicht** als (potentielles) Ziel — sichergestellt durch **dieselbe** `computeDrainState`-Logik (Regel 2), kein zweiter Regel-Satz.

## Acceptance-Kriterien

- **AC1** — `computeDrainState` **und** `computeStoryReadyStatus` behandeln eine Story mit `status: Waiting` wie `Blocked`/`Idee`: **nicht** in `targets`, **nicht** `couldBecomeReady`, **nie** eskaliert, `ready == false`. Rein additiv — kommt `Waiting` im Board **nicht** vor, bleibt jedes bestehende Verhalten unverändert (kein Regress an [[taktgeber-nachtwaechter]] AC1/AC3, [[drain-escalation-effectiveness]]). *(1,2)*
- **AC2** — `computeAliveStoryIds` und die `depends`-Auflösung sind robust gegen `Waiting`: eine `Waiting`-Story ist **nie „lebendig"** (wie `Blocked`/`Idee`); eine `depends`-Referenz auf eine `Waiting`-Story gilt als nicht erfüllter (nicht-`Done`) Vorgänger — **kein** Crash, **kein** fälschliches `ready`/`couldBecomeReady`, **keine** Endlosschleife. *(3)*
- **AC3** — Board-Ansicht (Frontend): `Waiting`-Storys erscheinen als **eigene, ruhige Kategorie** „Wartet (extern)" mit `wait_reason` als sichtbarem Text/Tooltip — **nicht** in der `Blocked`-Dauer-Blocker-Optik. Status/Grund **textlich** (nicht nur farblich); fehlt `wait_reason` → dezenter Default. Die bestehenden Status-Kategorien bleiben unverändert. *(4)*
- **AC4** — Der Nachtwächter-Vorab-Skip ([[nightwatch-idle-skip]] AC1) zählt eine `Waiting`-Story **nicht** als (potentielles) Drain-Ziel — über **dieselbe** `computeDrainState`-Ziel-Logik, kein zweiter Regel-Satz. *(5)*
- **AC5** — Die Status-**Definition** (`status: Waiting`, `wait_reason`, Konvention/Migration) wird **im agent-flow-Repo** spezifiziert und hier **nur** referenziert; diese Spec definiert ausschließlich den dev-gui-Anteil und ist **tolerant**, falls das Schema-Feld noch nicht überall gesetzt/vorhanden ist (fehlendes `wait_reason` → dezenter Default, fehlender Status-Wert → Bestandsverhalten). *(1)*

## Verträge

### Wiederverwendung / betroffene Bausteine (keine neuen Endpunkte)
- `computeDrainState` / `couldBecomeReadyViaDepends` / `computeAliveStoryIds` (`src/ProjectDrain.js`) — `Waiting` verhält sich strukturell bereits wie `Blocked`/`Idee` (Zweig „Status ≠ To Do/In Progress/Done ⇒ nie lebendig / kein Ziel"); die Spec verankert das explizit + per Test, **ohne** die Logik zu ändern.
- `computeStoryReadyStatus` (`src/BoardAggregator.js`) — liefert für jeden Nicht-`To Do`-Status `ready:false`; `Waiting` ist damit nie ready. Read-only.
- Board-Ansicht (Frontend, `client/src/…` Board-/Story-Rendering) — neue, ruhige Kategorie „Wartet (extern)" + `wait_reason`-Darstellung; getrennt von der `Blocked`-Optik.
- Bericht/Anzeige-Datenfluss: `Waiting` erscheint in `GET`-Board-Antworten wie ein normaler Status-Wert (additiv, kein Vertrags-Bruch).

### Datenfeld (extern definiert, hier nur konsumiert)
- `status: "Waiting"` (Board-Story-Status) und `wait_reason: string` — Schema-Herkunft: agent-flow-Repo (AC5). dev-gui liest sie tolerant.

## Edge-Cases & Fehlerverhalten
- **`Waiting`-Status kommt im Board nicht vor** → keinerlei Verhaltensänderung (Bestandsschutz, AC1/AC5).
- **`Waiting`-Story ohne `wait_reason`** → Board-Ansicht zeigt einen dezenten Default-Text („wartet extern"), kein Crash (AC3/AC5).
- **`depends` einer aktiven Story zeigt auf eine `Waiting`-Story** → Vorgänger gilt als nicht erfüllt; die abhängige Story wird **nicht** ready und **nicht** als `couldBecomeReady` gewertet (AC2) — sie bleibt liegen, statt fälschlich gedraint zu werden.
- **`Waiting` mischt sich mit Feature-Status-Rollup** → wie `Blocked`/`Idee` behandeln (nicht als „erledigt", nicht als „offen-abarbeitbar"); kein fälschliches „Done"-Rollup.

## NFRs
- **Kein Regress:** rein additive Behandlung; ohne `Waiting`-Vorkommen bit-identisches Bestandsverhalten.
- **Sicherheit (Floor):** `wait_reason` stammt aus dem Board (kein Freitext-Injection-Sink im Backend; Frontend rendert sicher). Keine Secrets/Pfade.
- **Robustheit:** kein Crash der Drain-/Aggregator-/Board-Analyse bei einem unbekannten/neuen Status-Wert (defensive Behandlung).

## Nicht-Ziele
- **Keine** Definition des Board-Schemas `status: Waiting`/`wait_reason` (liegt im agent-flow-Repo, AC5).
- **Keine** automatische `Blocked → Waiting`-Migration in dev-gui (Board-Datenhoheit liegt bei agent-flow).
- **Keine** Änderung der `computeDrainState`-Ziel-Logik selbst (nur explizite Verankerung + Board-Anzeige).
- **Kein** neuer Endpunkt, keine neue Autorisierung/Secrets.

## Abhängigkeiten
- [[taktgeber-nachtwaechter]] (Drain-Ziel-Definition AC1/AC3, `computeDrainState`, Eskalation) · [[nightwatch-idle-skip]] (`Waiting` automatisch kein Vorab-Skip-Ziel, AC4) · [[drain-escalation-effectiveness]] (`Waiting` nie eskaliert) · `BoardAggregator`/`computeStoryReadyStatus` · agent-flow-Repo (Status-Schema-Definition, extern, AC5).
