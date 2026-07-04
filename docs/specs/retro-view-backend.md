---
id: retro-view-backend
title: Retro-Sichtbarkeit — Backend-Boundary (RetroReader + /api/retro)
status: draft
area: retro-lernen
version: 1
---

# Spec: Retro-Sichtbarkeit — Backend-Boundary (`retro-view-backend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Stellt die **Self-Improvement-Historie** der agent-flow-Fabrik — alle Promotions aus `retro`/`train`/`teamLeader` — **read-only** über das Backend bereit: eine **Lauf-Übersicht** (gruppiert nach PR-Slug, absteigend nach Datum) und einen **Lauf-Report** (Einträge nach Kategorie gruppiert, optional mit gejointer Metrik). Quelle sind zwei Dateien in derselben Plugin-Root, die [[team-view-backend]] bereits auflöst: `LEARNINGS.md` (Markdown-Tabelle) und `.claude/metrics/baseline.json` (Metrik-„Matrix", derzeit Phase 0 / fehlend oder leer). Liefert die Datenbasis für [[retro-view-frontend]]. Schreibt nichts, führt nichts aus.

## Verhalten
1. Ein **RetroReader**-Boundary löst die agent-flow-Plugin-Root auf, indem er den **bestehenden Root-Resolver** von `AgentFlowReader` wiederverwendet (`resolvePluginRoot()` — ENV-Override `AGENT_FLOW_PLUGIN_ROOT` → neuestes Cache-Verzeichnis), und liest daraus:
   - **`LEARNINGS.md`** — Markdown-Tabelle mit Spalten `ID | Datum | Pack/Skill | Regel | Quelle | PR | Status`. Nur Datenzeilen (führendes `|`, keine Kopf-/Trenn-/Prosa-Zeilen) werden geparst.
   - **`.claude/metrics/baseline.json`** — Metrik-JSON mit u.a. `defect_rates[rule_id].rate_per_100ep`, `retro_effectiveness`, `weights`, `medians`, `learnings_rules`, `n_items`.
2. **Lauf-Gruppierung:** Ein *Lauf* = alle `LEARNINGS.md`-Zeilen mit **demselben Wert der Spalte `PR`** (PR-Slug). Der Lauf erbt `date` aus der Spalte `Datum` (bei mehreren Zeilen: das jüngste/erste Datum der Gruppe). Läufe werden **absteigend nach Datum** sortiert (jüngster zuerst); stabile Sekundär-Sortierung nach Slug.
3. **Quelle-Badge (`source`)** wird je Lauf aus dem **Slug-Präfix** abgeleitet (Spalte `Quelle`, ersatzweise `PR`): `retro/*` → `retro`, `train/*` → `train`, `teamLeader/*` **und** `team-add/*` → `teamLeader`. Alles andere (z.B. `feat/*`, `PR-Q…`) → `other`. Die Ableitung ist case-insensitiv und rein präfix-basiert (kein Datei-/Netzzugriff).
4. **Kategorie-Zuordnung:** Jeder Eintrag wird über die Spalte `Pack/Skill` einer von drei Kategorien zugeordnet: ein Token `agents/*` → **agents**, `skills/*` → **skills**, `knowledge/*` → **knowledge**. Enthält eine Zeile mehrere Pfade (z.B. `agents/cicd.md + knowledge/cicd.md + skills/cicd/SKILL.md`), zählt sie in **jede** der getroffenen Kategorien (ein logischer Eintrag kann in mehreren Sektionen erscheinen). Tokens ohne erkennbares Präfix landen in keiner der drei Kategorien (werden nicht erfunden).
5. **GET /api/retro/runs** liefert die **Übersicht**: Liste der Läufe mit `{ slug, date, source, counts, statusMix }`, **ohne** die Einzel-Regeltexte. `counts` zählt die getroffenen Kategorien je Lauf (`{ agents, skills, knowledge }`); `statusMix` aggregiert die Stati der Lauf-Zeilen (z.B. `{ Proposed: 2, Merged: 1 }`).
6. **GET /api/retro/runs/:slug** liefert den **Report** eines Laufs: die Einträge gruppiert in `agents` / `skills` / `knowledge`. Je Eintrag: `{ id, rule, status, provenance }` — `rule` = prägnante Ein-Satz-Zusammenfassung aus Spalte `Regel`, `status` = Spalte `Status`, `provenance` = Spalte `Quelle`. **Metrik-Join:** existiert in `baseline.json.defect_rates` ein Eintrag unter dem `rule_id` des Eintrags (abgeleitet aus Spalte `ID`/`Regel`-Marker), wird `{ rate_per_100ep, baseline, neu, status }` ergänzt; sonst bleibt das Metrik-Feld `null`.
7. **Phase 0 / leere Metrik:** Fehlt `baseline.json` **vollständig** ODER ist sie leer / hat `n_items: 0` / enthält kein `defect_rates`, liefert der Report **trotzdem 200** mit allen Einträgen, deren Metrik-Feld durchgängig `null` ist. Es wird **kein** 500 geworfen, kein Eintrag verschluckt.
8. **Degradation `LEARNINGS.md`:** Fehlt `LEARNINGS.md` oder enthält sie keine Datenzeilen, liefert `GET /api/retro/runs` **200** mit **leerer** Liste; ein Report-Aufruf auf einen dann nicht existenten Slug liefert **404**. Kein 500, kein Crash.
9. Beide Endpunkte sind **read-only** und sitzen hinter dem bestehenden **AccessGuard** auf `/api/*` (Verdrahtung in `server.js` analog zu `teamRouter`). Keine neue Autorisierung, keine neuen Secrets.

## Acceptance-Kriterien
- **AC1** — `GET /api/retro/runs` antwortet **200** mit `{ runs: [...] }`. Jeder Lauf hat `{ slug, date, source, counts:{ agents, skills, knowledge }, statusMix }`. Kein Lauf-Eintrag in der Übersicht enthält die Einzel-Regeltexte (`rule`). Läufe sind **absteigend nach `date`** sortiert.
- **AC2** (Lauf-Gruppierung) — Alle `LEARNINGS.md`-Zeilen mit **identischem PR-Slug** (Spalte `PR`) werden zu **genau einem** Lauf zusammengefasst; `date` des Laufs stammt aus Spalte `Datum`. Mehrere Zeilen mit demselben Slug erzeugen **keinen** doppelten Lauf.
- **AC3** (Quelle-Badge) — `source` wird rein aus dem Slug-Präfix abgeleitet: `retro/…` → `retro`, `train/…` → `train`, `teamLeader/…` **oder** `team-add/…` → `teamLeader`, alles andere → `other`. Die Ableitung ist case-insensitiv und erfolgt **ohne** Datei-/Netzzugriff.
- **AC4** (Kategorie-Zuordnung) — Aus Spalte `Pack/Skill` wird je Pfad-Token kategorisiert: `agents/*` → agents, `skills/*` → skills, `knowledge/*` → knowledge. Eine Zeile mit mehreren Pfaden zählt in **jede** getroffene Kategorie; `counts` der Übersicht spiegelt diese Zuordnung. Tokens ohne erkennbares Präfix erzeugen **keine** erfundene Kategorie.
- **AC5** — `GET /api/retro/runs/:slug` antwortet für einen existierenden Slug **200** mit `{ slug, date, source, statusMix, agents:[…], skills:[…], knowledge:[…] }`. Jeder Eintrag hat `{ id, rule, status, provenance, metric }`, wobei `rule` aus Spalte `Regel`, `status` aus Spalte `Status`, `provenance` aus Spalte `Quelle` stammt.
- **AC6** (Metrik-Join) — Existiert in `baseline.json.defect_rates` ein Eintrag unter dem `rule_id` des Eintrags, enthält dessen `metric` `{ rate_per_100ep, baseline, neu, status }` aus `baseline.json`; existiert keiner, ist `metric` `null`. Es werden **keine** Metrik-Werte erfunden.
- **AC7** (Phase 0 / leere Metrik) — Fehlt `baseline.json` vollständig oder ist sie leer / `n_items: 0` / ohne `defect_rates`, liefert `GET /api/retro/runs/:slug` **200** mit allen Einträgen und durchgängig `metric: null` (kein 500, kein verschluckter Eintrag).
- **AC8** (Slug-Validierung / Path-Traversal) — `:slug` wird **vor** jedem Zugriff streng gegen eine Whitelist/Regex validiert (erlaubte Zeichen inkl. `/` für mehrteilige Slugs, **kein** `..`, **kein** `\`, kein Null-Byte). Ein Slug, der auf keinen geparsten Lauf passt, liefert **404**; ein Traversal-Versuch führt **niemals** zu einem Dateizugriff außerhalb der gelesenen Quelldateien.
- **AC9** (Degradation) — Fehlt `LEARNINGS.md` oder hat sie keine Datenzeilen, liefert `GET /api/retro/runs` **200** mit leerer `runs`-Liste; ein Report-Aufruf liefert **404**. Es wird **kein** 500 geworfen und der Prozess crasht nicht.
- **AC10** (Security/Floor) — Beide Endpunkte sind **read-only**, hinter dem bestehenden AccessGuard auf `/api/*` verdrahtet (Muster wie `teamRouter`), führen **keine** neue Autorisierung und **keine** neuen Secrets ein; es werden ausschließlich `LEARNINGS.md` und `.claude/metrics/baseline.json` der aufgelösten Plugin-Root gelesen, keine Dateien außerhalb. Responses enthalten keine Secrets/Tokens.

## Verträge
- **Boundary `RetroReader`** (ESM, async): nutzt `agentFlowReader.resolvePluginRoot()` (oder einen gleichwertigen injizierten Resolver), parst `LEARNINGS.md` zu Läufen + Einträgen, liest/joint `baseline.json`; injizierbare FS-/Resolver-Deps für Tests (analog `AgentFlowReader.fsDeps`).
- **`GET /api/retro/runs`** → `200`
  ```
  {
    runs: [
      { slug, date, source, counts: { agents, skills, knowledge }, statusMix: { <Status>: <n> } }
    ]
  }
  ```
  `source` ∈ `{ retro, train, teamLeader, other }`; leere `runs`-Liste bei fehlender Quelle.
- **`GET /api/retro/runs/:slug`** → `200`
  ```
  {
    slug, date, source, statusMix,
    agents:    [{ id, rule, status, provenance, metric }],
    skills:    [{ id, rule, status, provenance, metric }],
    knowledge: [{ id, rule, status, provenance, metric }]
  }
  ```
  `metric` = `{ rate_per_100ep, baseline, neu, status } | null`.
  `:slug` validiert gegen Whitelist (z.B. `^[a-zA-Z0-9._/-]+$`), kein `..`, kein `\`, kein Null-Byte → sonst 404.
- **Verdrahtung** in `server.js`: `app.use(retroRouter({ retroReader }))` hinter `app.use('/api', accessGuard)` — analog zur bestehenden Router-Reihe (`teamRouter`).

## Edge-Cases & Fehlerverhalten
- `LEARNINGS.md` fehlt / keine Datenzeilen → leere `runs`-Liste, 200 (AC9); Report-Aufruf → 404.
- `baseline.json` fehlt / leer / `n_items: 0` / kein `defect_rates` → Report 200, `metric: null` überall (AC7).
- Zeile mit mehreren Pfaden in `Pack/Skill` → zählt in jede getroffene Kategorie (AC4).
- Mehrere Zeilen mit demselben PR-Slug → ein Lauf, aggregierter `statusMix` (AC2).
- Slug mit `..`, `\`, Null-Byte oder unerlaubten Zeichen → 404, kein Dateizugriff (AC8).
- Unbekannter (gültig formatierter) Slug → 404.
- Malformte Tabellenzeile (falsche Spaltenzahl) → übersprungen, kein Crash.

## NFRs
- **Sicherheit (Floor):** read-only; Slug-Validierung gegen Traversal; nur `LEARNINGS.md` + `baseline.json` der Plugin-Root gelesen; keine Secrets in Response/Log; hinter AccessGuard; keine neue Autorisierung.
- **Robustheit:** vollständige Degradation ohne `LEARNINGS.md`/`baseline.json` (leere Liste / `metric: null` statt Fehler).
- **Performance:** Übersicht ohne Einzel-Regeltexte; optionales In-Memory-Cache erlaubt (Quelle ändert selten), darf Degradations-/Sicherheitsverhalten nicht ändern.
- **Portabilität:** Root-Auflösung über den bestehenden Resolver — funktioniert lokal **und** im Container (ENV-Override respektiert).

## Nicht-Ziele
- **Kein** Editieren/Schreiben von `LEARNINGS.md`/`baseline.json` (strikt read-only).
- **Kein** Triggern von retro/train/teamLeader aus diesem Endpunkt.
- **Keine** neue Datenbank/Persistenz (live aus dem Dateisystem, ADR-konform).
- **Kein** Markdown-Rendering im Backend (Regel-Text bleibt roh; Rendering ist Frontend-Sache, [[retro-view-frontend]]).
- **Keine** Erfindung von Metrik-/Kategorie-/Quelle-Werten, wenn die Quelle nichts hergibt.

## Abhängigkeiten
- [[team-view-backend]] (`AgentFlowReader.resolvePluginRoot()` als wiederverwendeter Root-Resolver).
- [[access-and-guardrails]] (AccessGuard auf `/api/*`, unverändert).
- Liefert die Datenbasis für [[retro-view-frontend]].
- Muster: bestehende Reader/Router (`AgentFlowReader`, `teamRouter`) in `src/`.
