---
id: retro-trend-backend
title: Retro-Trend — Backend-Boundary (Momentum-Aggregation + /api/retro/trend)
status: draft
area: retro-lernen
version: 1
---

# Spec: Retro-Trend — Backend-Boundary (`retro-trend-backend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Stellt — **read-only** und ohne neue Messung — die **Trajektorien-Sicht** auf die Self-Improvement-Effektivität der agent-flow-Fabrik bereit: je Artefakt-Kategorie (Knowledge Packs / Agent-Defs / Skills) und je Retro-Lauf das **Momentum** (Veränderung der Defektrate seit dem letzten Retro), gruppiert nach **Regel-ID-Präfix**. Es ist die Trend-Ergänzung zu [[retro-view-backend]] (Lauf-Historie) und liefert die Datenbasis für [[retro-trend-frontend]]. Quelle ist **dieselbe** `.claude/metrics/baseline.json`, die [[retro-view-backend]] bereits liest — neu ist ausschließlich die **Gruppierung + Delta-Bildung** des Vorhandenen. Schreibt nichts, führt nichts aus, misst nichts neu.

## Verhalten
1. **Wiederverwendung der Boundary:** Die Momentum-Aggregation lebt im bestehenden **`RetroReader`** (oder einer von ihm genutzten reinen Helper-Funktion) und liest über denselben Plugin-Root-Resolver (`resolvePluginRoot()` aus `AgentFlowReader`, ENV-Override `AGENT_FLOW_PLUGIN_ROOT` → neuestes Cache-Verzeichnis) **ausschließlich** `.claude/metrics/baseline.json`. Es wird **keine** weitere Datei und **kein** Netz gelesen.
2. **Neuer Endpunkt `GET /api/retro/trend?category=<knowledge|agents|skills>`** im bestehenden `retroRouter` (hinter dem `/api/*`-AccessGuard, wie `GET /api/retro/runs`). Fehlt der Query-Parameter, gilt `category=knowledge` als Default. Ein unbekannter `category`-Wert liefert **400** (kein 500, kein Raten).
3. **Datenquelle (keine neue Messung):** Die Momentum-Werte werden **rein** aus `baseline.json` abgeleitet:
   - `learnings_rules[]` — je Eintrag `{ rule_id, status, baseline_rate, baseline_n, promoted_after_item, measured_rate, measured_n }`. Das ist die kanonische Quelle für „eine Regel hat in einem Retro-Lauf den Status gewechselt".
   - `defect_rates{ rule_id → { rate_per_100ep, n_items, … } }` — Hilfsquelle für die aktuelle Rate/`n_items` einer Regel, falls in `learnings_rules` nicht vorhanden.
4. **Bahn-Zuordnung über Regel-ID-Präfix** (rein string-basiert, kein Datei-/Netzzugriff): Der Teil des `rule_id` **vor dem ersten `/`** ist der **Präfix** (z.B. `coder/R01` → `coder`, `reviewer/R03` → `reviewer`, `spring-boot-3/B04` → `spring-boot-3`, `maven/B02` → `maven`, `java/B07` → `java`). Die Kategorie einer Bahn wird aus dem Präfix bestimmt:
   - Präfix ist ein **bekannter Agent-Name** (`coder`, `reviewer`, `tester`, `dba`, `cicd`, `architekt`, `designer`, `requirement`, `teamLeader`) → Kategorie **agents**; jede solche Präfix-Gruppe ist **eine Bahn** (z.B. Bahn `coder`).
   - andernfalls (jeder andere Präfix, z.B. `spring-boot-3`, `maven`, `java`) → Kategorie **knowledge**; jede solche Präfix-Gruppe ist **eine Bahn** (= ein Knowledge Pack).
   - **skills** — siehe AC7 (strukturelle Asymmetrie): es gibt **keine** Skill-tragenden Regel-IDs; `category=skills` liefert immer leere Bahnen + ein explizites `placeholder`-Feld.
   Die Agent-Allowlist ist als **bindende Konstante** in der Boundary geführt (kein Hardcoding verstreut); Präfixe ausserhalb gelten als Knowledge-Pack-Bahnen.
5. **X-Achse (Retro-Läufe, chronologisch):** Die Punktreihe einer Bahn ist über die **Retro-Läufe** indiziert — dieselbe Lauf-Ordnung wie `GET /api/retro/runs`, aber **aufsteigend nach Datum** (ältester zuerst), damit eine Trajektorie links→rechts in der Zeit verläuft. Ein „Lauf" für die Trend-Sicht ist ein Retro-Promotionsereignis: ein `learnings_rules`-Eintrag wird dem Lauf zugeordnet, in dem sein Status (zu `Validated`/`Reverted`/`Measuring`) festgeschrieben wurde — abgeleitet aus `promoted_after_item` (Sortierschlüssel) bzw. dem zugehörigen `LEARNINGS.md`-PR-Slug/Datum, falls eindeutig auflösbar; ist keine Lauf-Zuordnung auflösbar, werden die Promotionsereignisse **stabil nach `promoted_after_item` aufsteigend** als sequentielle Trend-Schritte angeordnet.
6. **Y-Momentum (Δ Defektrate seit letztem Retro):** Für eine Bahn `B` und einen Trend-Schritt `i` ist
   ```
   momentum(B, i) = Σ über die Regeln r von B, die in Schritt i ihren Status gewechselt haben:
                      (baseline_rate(r) − measured_rate(r)) × n_items(r) / 100
   ```
   wobei `n_items(r)` = `measured_n(r)` (Fallback: `baseline_n(r)`, Fallback `defect_rates[r].n_items`, Fallback `0`). **Positives Momentum = Verbesserung** (Defektrate gesunken → Bahn steigt über die Mittellinie); **negatives = Verschlechterung/Reverted** (Bahn fällt). Das ist **dieselbe** Formel wie `retro_effectiveness` (metrics-subsystem §8), nur **pro Präfix-Bahn statt global** aggregiert.
7. **Mittellinie / erster Punkt:** Die Y-Achse ist um die **Mittellinie 0** (keine Änderung) zentriert. Der **erste** Trend-Schritt einer Bahn liegt auf `momentum = 0` (es gibt kein vorheriges Retro für ein Delta). Eine Bahn braucht **≥ 2** Trend-Schritte, damit ein echtes Delta sichtbar wird (AC5).
8. **Antwort-Form:** `GET /api/retro/trend` liefert **200** mit `{ category, lanes: [...], runs: [...], placeholder? }`. `lanes` ist ein Array von Bahnen `{ id, label, points: [{ run, date, momentum, contributingRules }] }`; `points` ist **aufsteigend** nach Lauf/Datum sortiert; `contributingRules` ist die (ggf. leere) Liste der `rule_id`, die zu diesem Punkt-Momentum beigetragen haben. `runs` ist die geordnete Liste der X-Achsen-Beschriftungen `{ run, date }` (aufsteigend), gemeinsam für alle Bahnen.
9. **Skills-Asymmetrie (`category=skills`):** Antwortet **200** mit `lanes: []` und einem **`placeholder`**-Feld (z.B. `"— noch keine Messmethode für Skill-Güte"`), konsistent mit dem `metric: null`-Muster aus [[retro-view-backend]]. **Kein** 500, **kein** erfundener Wert, **kein** verschluckter Fehler.
10. **Phase 0 / leere Quelle:** Fehlt `baseline.json` vollständig ODER ist sie leer / hat `n_items: 0` / leeres `defect_rates` / leeres `learnings_rules`, liefert der Endpunkt **trotzdem 200** mit `lanes: []`, `runs: []` und einem erkennbaren **Leerzustands-Marker** (`empty: true`). **Kein** 500, **kein** Crash. Das ist der derzeit erwartete Zustand.
11. **Determinismus & Read-Only:** Gleiche Quelle → gleiche Antwort (stabile Sortierung). Der Endpunkt schreibt **nichts** (kein `baseline.json`/`LEARNINGS.md`), triggert **nicht** retro/train/teamLeader, mintet **keine** Secrets.

## Acceptance-Kriterien
- **AC1** (Endpunkt + Default) — `GET /api/retro/trend` ohne `category` antwortet **200** und behandelt die Anfrage als `category=knowledge`; `GET /api/retro/trend?category=agents` und `…?category=skills` antworten ebenfalls **200**. Die Route sitzt hinter dem bestehenden `/api/*`-AccessGuard (Verdrahtung wie `GET /api/retro/runs`).
- **AC2** (Antwort-Form) — Eine **200**-Antwort hat die Form `{ category, lanes: [{ id, label, points: [{ run, date, momentum, contributingRules }] }], runs: [{ run, date }] }`. `points` jeder Bahn ist **aufsteigend nach Datum/Lauf** sortiert; `runs` ist dieselbe aufsteigende X-Achsen-Ordnung, gemeinsam für alle Bahnen. `momentum` ist eine Zahl; `contributingRules` ein (ggf. leeres) Array von `rule_id`.
- **AC3** (Präfix-Gruppierung) — Jede Bahn entspricht **genau einem** Regel-ID-Präfix (Teil vor dem ersten `/`). `category=agents` enthält **ausschließlich** Bahnen, deren Präfix in der bindenden Agent-Allowlist (`coder`, `reviewer`, `tester`, `dba`, `cicd`, `architekt`, `designer`, `requirement`, `teamLeader`) liegt; `category=knowledge` enthält **ausschließlich** Bahnen mit Präfixen **ausserhalb** dieser Allowlist (= Knowledge Packs). Eine Regel-ID ohne `/` oder mit leerem Präfix erzeugt **keine** erfundene Bahn.
- **AC4** (Momentum-Formel) — Für eine Bahn und einen Trend-Schritt gilt `momentum = Σ (baseline_rate − measured_rate) × n_items / 100` über die in diesem Schritt status-wechselnden Regeln der Bahn, mit `n_items = measured_n ?? baseline_n ?? defect_rates[rule_id].n_items ?? 0`. Eine gesunkene Defektrate (`baseline_rate > measured_rate`) ergibt **positives** Momentum, eine gestiegene **negatives**. Es werden **keine** Werte erfunden, wenn die Quelle für eine Regel unvollständig ist (fehlende Felder → der Beitrag dieser Regel ist `0`, kein Crash).
- **AC5** (Mittellinie / ≥2-Punkte-Regel) — Der **erste** Punkt jeder Bahn hat `momentum = 0` (kein vorheriges Retro). Eine Bahn mit nur einem Trend-Schritt liefert genau diesen einen Nullpunkt (kein Delta); ein echtes Delta erscheint erst ab dem **zweiten** Punkt.
- **AC6** (Reverted = negativ) — Eine Regel, die in einem Schritt von `Validated`/`Measuring` auf `Reverted` (bzw. mit gestiegener `measured_rate`) wechselt, trägt ein **negatives** Momentum zu ihrer Bahn bei; die Bahn fällt in diesem Schritt unter ihren vorherigen Wert.
- **AC7** (Skills-Asymmetrie) — `GET /api/retro/trend?category=skills` antwortet **200** mit `lanes: []` und einem nicht-leeren `placeholder`-String (z.B. `"— noch keine Messmethode für Skill-Güte"`). Es wird **kein** 500 geworfen, **kein** Skill-Wert erfunden und **kein** Fehler verschluckt.
- **AC8** (Phase 0 / leere Quelle) — Fehlt `baseline.json` vollständig oder ist sie leer / `n_items: 0` / ohne `defect_rates` / mit leerem `learnings_rules`, liefert `GET /api/retro/trend` **200** mit `lanes: []`, `runs: []` und `empty: true`. **Kein** 500, der Prozess crasht nicht.
- **AC9** (Validierung `category`) — Ein `category`-Wert ausserhalb `{ knowledge, agents, skills }` (z.B. `?category=../`, `?category=foo`) liefert **400** mit JSON-Fehler **vor** jedem Daten-/Dateizugriff. Es findet **kein** Dateizugriff für ungültige Eingaben statt; kein 500.
- **AC10** (Determinismus) — Bei identischer Quelle liefert wiederholtes Aufrufen **identische** `lanes`/`runs` (stabile Sortierung der Bahnen nach `id`, der Punkte nach Datum/Lauf, der `contributingRules` nach `rule_id`).
- **AC11** (Security/Floor) — Der Endpunkt ist **read-only**, liest **ausschliesslich** `.claude/metrics/baseline.json` der aufgelösten Plugin-Root (keine weitere Datei, kein Netz), schreibt **nichts**, triggert **nicht** retro/train/teamLeader, führt **keine** neue Autorisierung und **keine** neuen Secrets ein; Responses/Logs enthalten **keine** Secrets/Tokens.

## Verträge
- **`GET /api/retro/trend?category=<knowledge|agents|skills>`** → `200`
  ```
  {
    category: "knowledge" | "agents" | "skills",
    empty?: true,                       // nur im Phase-0/Leerzustand
    placeholder?: "…",                  // nur bei category=skills (oder anderen messmethoden-losen Kategorien)
    runs: [ { run: "<slug|index>", date: "<YYYY-MM-DD>" } ],   // aufsteigend, gemeinsame X-Achse
    lanes: [
      {
        id: "coder" | "spring-boot-3" | "maven" | …,           // = Regel-ID-Präfix
        label: "coder" | "spring-boot-3" | …,                   // Anzeige-Label (= id, ggf. lesbarer)
        points: [
          { run: "<slug|index>", date: "<YYYY-MM-DD>", momentum: <number>, contributingRules: ["coder/R01", …] }
        ]
      }
    ]
  }
  ```
  - `momentum` zentriert um `0`; positiv = Verbesserung, negativ = Verschlechterung.
  - erster Punkt jeder Bahn: `momentum = 0`, `contributingRules: []`.
- **`GET /api/retro/trend?category=<ungültig>`** → `400 { error: "invalid category" }` (vor jedem Datenzugriff).
- **Boundary** (Erweiterung `RetroReader`, ESM, async): neue Methode `getTrend(category)` + reine Helper (`derivePrefix(ruleId)`, `prefixCategory(prefix)`, `computeMomentum(lanes)`), alle injizierbar/testbar wie die bestehenden Helper (`deriveSource`, `categoriseEntry`); FS-/Resolver-Deps weiterhin injizierbar (`fsDeps`, `pluginRootResolver`).
- **Verdrahtung** in `retroRouter`: neue Route `GET /api/retro/trend` neben `GET /api/retro/runs`, hinter `app.use('/api', accessGuard)`.
- **Quelle-Schema** wie metrics-subsystem §2.3: `learnings_rules[] = { rule_id, status, baseline_rate, baseline_n, promoted_after_item, measured_rate, measured_n }`; `defect_rates = { rule_id → { rate_per_100ep, n_items, … } }`.

## Edge-Cases & Fehlerverhalten
- `baseline.json` fehlt / leer / `n_items: 0` / leeres `defect_rates` / leeres `learnings_rules` → 200, `lanes: []`, `runs: []`, `empty: true` (AC8).
- `category=skills` → 200, `lanes: []`, `placeholder` gesetzt (AC7).
- ungültiges `category` (inkl. Traversal-artige Strings) → 400 vor Datenzugriff (AC9).
- Regel mit fehlenden Feldern (`measured_rate`/`baseline_rate`/`n` null) → Beitrag 0, kein Crash (AC4).
- Regel-ID ohne `/` oder leerem Präfix → keine Bahn (AC3).
- Bahn mit nur einem Promotionsereignis → genau ein Nullpunkt (AC5).
- Nicht auflösbare Lauf-/Datum-Zuordnung → stabile Reihung nach `promoted_after_item` (Verhalten §5), kein Crash.

## NFRs
- **Sicherheit (Floor):** read-only; nur `baseline.json` der Plugin-Root gelesen; `category`-Whitelist vor Zugriff; keine Secrets in Response/Log; hinter AccessGuard; keine neue Autorisierung; kein Trigger von retro/train/teamLeader.
- **Robustheit:** vollständige Degradation ohne/mit leerer `baseline.json` (leere Bahnen statt Fehler); Best-Effort bei unvollständigen Regel-Feldern (Beitrag 0).
- **Determinismus:** stabile Sortierung (Bahnen nach `id`, Punkte nach Datum/Lauf, `contributingRules` nach `rule_id`) — AC10.
- **Performance:** eine `baseline.json`-Lesung pro Aufruf; reine Arithmetik; optionales In-Memory-Cache erlaubt (Quelle ändert ~1×/Woche), darf Degradations-/Sicherheitsverhalten nicht ändern.
- **Portabilität:** Root-Auflösung über den bestehenden Resolver (lokal + Container, ENV-Override).

## Nicht-Ziele
- **Keine** neue Messung / kein neuer Ledger / keine EP-Berechnung — nur Gruppierung + Delta des Vorhandenen.
- **Kein** Schreiben von `baseline.json`/`LEARNINGS.md` (strikt read-only).
- **Kein** Triggern von retro/train/teamLeader.
- **Keine** erfundenen Skill-Metriken (strukturelle Asymmetrie offen ausgewiesen, AC7).
- **Keine** neue Datenbank/Persistenz; **kein** Chart-Rendering im Backend (das ist Frontend-Sache, [[retro-trend-frontend]]).
- **Keine** Secrets in Response/Log.

## Abhängigkeiten
- [[retro-view-backend]] (`RetroReader`-Boundary + `retroRouter` + Plugin-Root-Resolver werden erweitert, nicht ersetzt; gleiche `baseline.json`-Quelle).
- [[team-view-backend]] (`AgentFlowReader.resolvePluginRoot()` als wiederverwendeter Root-Resolver).
- [[access-and-guardrails]] (AccessGuard auf `/api/*`, unverändert).
- Liefert die Datenbasis für [[retro-trend-frontend]].
- Datenquelle-Schema: agent-flow `docs/architecture/metrics-subsystem.md` §2.3/§8 (`learnings_rules`, `defect_rates`, `retro_effectiveness`).
