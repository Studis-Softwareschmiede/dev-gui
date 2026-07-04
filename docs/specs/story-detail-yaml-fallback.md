---
id: story-detail-yaml-fallback
title: Story-Detail — Fallback aus Board-YAML, robustes ID-Matching, klarer Leer-Zustand
status: draft
area: board
version: 1
---

# Spec: Story-Detail — YAML-Fallback & robustes Matching  (`story-detail-yaml-fallback`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. Source of Truth für coder/tester/reviewer.
>
> **Erweitert [[story-detail-ansicht]].** Die Detailansicht ist gebaut, bleibt für viele Stories aber leer, weil das Metrik-Ledger keine Daten enthält. Diese Spec holt **sofort mehr aus den bereits vorhandenen Board-YAML-Daten** heraus und macht das ID-Matching robust. Die eigentliche Aufzeichnungs-Lücke wird **stromaufwärts** behoben (Schwester-Konzept `metrics-recording-reliability` im agent-flow).

## Zweck

Klick auf eine Story zeigt heute oft nur „—" und „Keine Flow-Daten vorhanden" (siehe S-165). Ursache ist **nicht** die Anzeige, sondern fehlende/unauffindbare Ledger-Daten. Diese Spec liefert auch ohne Ledger **so viel Detail wie aus der Board-YAML ableitbar** ist (Ende, Branch, PR, Vorab-Schätzung), erklärt den Leer-Zustand verständlich und behebt einen latenten ID-Format-Bruch, der Ledger-Zeilen am Matchen hindert.

## Kontext / Befund (bindend)

- **Drei Befunde** (live verifiziert 2026-06-19 an S-165):
  1. **Ledger ohne Zeile:** `.claude/metrics/items.jsonl`/`dispatches.jsonl` enthalten für S-165 (und alle Stories ab ~16.06.) **keine** Zeile → Zeiten/Flow/Ist leer. *(Wurzel: agent-flow, siehe Schwester-Konzept.)*
  2. **ID-Format-Bruch:** `StoryMetricReader` matcht `item` per **Voll-String** gegen `"S-165"`. Ältere Ledger-Zeilen schreiben `item` aber als **Zahl** (`165`, `108`…). `String(165) === "S-165"` → **false** → selbst vorhandene Zeilen matchen nicht. *(dev-gui-Fix, hier.)*
  3. **Tokens nie befüllt:** `tok` ist überall `null`. *(Wurzel: agent-flow.)*
- **Owner-Entscheidung 2026-06-19:** Fix auf **beiden** Ebenen (Anzeige hier + Aufzeichnung im agent-flow). Für **bereits erledigte** Stories wird **nur das aus der YAML Ableitbare** gezeigt — der Agenten-Flow/Startzeit lässt sich nicht rekonstruieren.
- **Read-only bleibt.** Diese Spec ändert keine Schreibpfade; sie liest zusätzliche, bereits vorhandene YAML-Felder.

## Verhalten

### V1 — Board-Index um YAML-Felder erweitern (Backend)
`BoardAggregator` exponiert pro Story zusätzlich die bereits in der Story-YAML vorhandenen Felder `done_at`, `branch`, `pr` (heute nicht im Index — nur `dispo_est`/`dispo_act` u.a.). Fehlende Felder → `null`.

### V2 — Robustes ID-Matching (Backend, StoryMetricReader)
Der Vergleich `item ↔ storyId` matcht tolerant:
- **String-Gleichheit** (`"S-165" == "S-165"`), ODER
- **numerische Gleichheit** nach Normalisierung: aus `item` und `storyId` jeweils die Zahl extrahieren (Präfix `S-` + führende Nullen entfernen) und vergleichen (`165 == 165`).
Damit matchen sowohl neue String-Zeilen als auch alte Integer-Zeilen. Reiner Wertvergleich — `storyId`/`item` werden nie als Pfad benutzt (Security unverändert).

### V3 — YAML-Fallback im Detail-Endpoint (Backend)
`GET /api/board/projects/:slug/stories/:id/detail` ergänzt — analog zum bestehenden `ep_est`-Fallback:
- **Ende:** liefert das Ledger kein `ended_at`, aber die YAML ein `done_at` → `ended_at = done_at`, Herkunft `ended_at_source: 'yaml'` (sonst `'ledger'`).
- **Start/Dauer:** bleiben `null`, wenn kein Ledger (aus der YAML **nicht** ableitbar — bewusst, kein geschätzter Wert).
- **Neue Felder durchreichen:** `branch`, `pr`, `status` aus dem Index.

### V4 — Leer-Zustand verständlich (Frontend)
Statt pauschal „Keine Flow-Daten vorhanden":
- Ledger-Flow leer **und** `done_at` vorhanden → „Vor Metrik-Erfassung abgeschlossen — kein Agenten-Flow aufgezeichnet."
- Ledger-Flow leer **und** Story nicht erledigt → „Noch kein Flow-Lauf erfasst."
Zeiten-Block: zeigt **Ende** auch aus der YAML (dezente Herkunfts-Markierung, analog `VORAB`-Badge bei der Schätzung).

### V5 — Block „Verknüpfungen" (Frontend)
Neuer kleiner Block mit **Branch** (Text) und **PR** (externer Link), wenn in der YAML vorhanden; sonst Block ausblenden. Gibt auch ohne Ledger einen konkreten Absprungpunkt.

## Acceptance-Kriterien

- **AC1** — `BoardAggregator`-Story-Index enthält `done_at`, `branch`, `pr` (null wenn YAML-Feld fehlt). *(V1)*
- **AC2** — `StoryMetricReader` matcht `item` gegen die Story-ID sowohl bei String- (`"S-165"`) als auch bei Integer-Ledgerzeilen (`165`); kein Pfad-Gebrauch von `item`/`id`. *(V2)*
- **AC3** — Detail-Endpoint setzt `ended_at` aus `done_at`, wenn der Ledger keines liefert, und markiert `ended_at_source` (`'ledger'|'yaml'`); `started_at`/`duration` bleiben null ohne Ledger. *(V3)*
- **AC4** — Detail-Response enthält `branch`, `pr`, `status` aus dem Index. *(V3)*
- **AC5** — Frontend zeigt differenzierten Leer-Hinweis (vor Metrik-Erfassung abgeschlossen vs. noch kein Flow) statt der pauschalen Meldung; Ende wird auch aus YAML angezeigt (mit Herkunfts-Markierung). *(V4)*
- **AC6** — Frontend zeigt einen „Verknüpfungen"-Block mit Branch + PR-Link, wenn vorhanden; sonst kein Block. *(V5)*
- **AC7** — Bestehendes Verhalten unverändert: hat der Ledger volle Daten, werden Zeiten/Flow/Ist wie bisher gezeigt (Ledger hat Vorrang vor YAML). *(V3)*
- **AC8** — A11y/Security-Floor wie [[story-detail-ansicht]]: kein `dangerouslySetInnerHTML`, externer PR-Link mit `rel="noopener noreferrer"`, nur bestehende `/api/board/*`-Endpunkte. *(alle)*

## Verträge

- **`GET /api/board/projects/:slug/stories/:id/detail`** → `{ detail }`, erweitert um: `ended_at_source: 'ledger'|'yaml'|null`, `branch: string|null`, `pr: string|null`, `status: string|null`. Bestehende Felder unverändert.
- **BoardAggregator-Index** (`StoryEntry`): zusätzlich `done_at`, `branch`, `pr`.

## Edge-Cases & Fehlerverhalten

- **Ledger vorhanden, aber als int geschrieben** → matcht jetzt (AC2); Zeiten/Flow/Ist erscheinen.
- **Kein Ledger, aber Done** → Ende aus YAML, Start/Dauer null, klarer Hinweis, Branch/PR-Block (AC3/AC5/AC6).
- **Kein Ledger, nicht Done** → „Noch kein Flow-Lauf erfasst", keine Zeiten.
- **YAML-Feld fehlt** (`pr: null`) → Feld/Block ausgeblendet, kein „null"-Text.

## Nicht-Ziele

- **Rekonstruktion von Agenten-Flow/Startzeit** für Alt-Stories (nicht ableitbar).
- **Änderung der Aufzeichnung** — das ist agent-flow (`metrics-recording-reliability`).
- **Token-Befüllung** — ebenfalls agent-flow (Quelle `tok`).

## Abhängigkeiten

- **dev-gui:** `src/BoardAggregator.js` (YAML-Felder), `src/StoryMetricReader.js` (Matching), `src/boardRouter.js` (Endpoint-Fallback), Frontend-Story-Detail-Komponente (Leer-Zustand + Verknüpfungen-Block).
- **Specs:** [[story-detail-ansicht]] (Basis).
- **Cross-Repo (Wurzel):** agent-flow `metrics-recording-reliability` — füllt das Ledger für künftige Stories; erst damit erscheinen Start/Flow/Ist/Tokens.
