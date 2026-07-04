---
id: team-detail-related-refs
title: Team-Ansicht — zugehörige Skills/Knowledge eines Agenten (verlinkt)
status: draft
area: retro-lernen
version: 1
---

# Spec: Team-Ansicht — zugehörige Skills/Knowledge eines Agenten (`team-detail-related-refs`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Macht im **Agent-Detail** der Team-Ansicht die zu einem Agenten **gehörenden Skills und Knowledge-Packs** als eigene, **anklickbare** Einträge sichtbar. Ein Klick wechselt die Selektion in der bestehenden Master-Detail-Navigation auf das referenzierte Skill bzw. Knowledge (gleiche View, kein Reload). Umgekehrt zeigt das **Skill-/Knowledge-Detail** die **nutzenden Agenten** ("Verwendet von …"), ebenfalls anklickbar. Erweitert [[team-view-backend]] (Auflösung der Referenzen) und [[team-view-frontend]] (Darstellung + Navigation); **strikt read-only**.

## Designentscheidungen (Defaults — vom requirement-Agent gesetzt, da Rückfrage im Subagent-Kontext nicht möglich war; Alternativen explizit, falls der Betreiber abweichen will)
- **(a) Herkunft der Zuordnung — Frontmatter mit Vorrang, Body-Parsing als Fallback.** Befund aus dem installierten Plugin: `agents/*.md` besitzen **kein** `skills`/`knowledge`-Frontmatter-Feld (nur `name`, `description`, `tools`, `model`); Referenzen stehen ausschließlich als **Text im Body** — Knowledge als Pfade (`knowledge/<pfad>.md`, `${CLAUDE_PLUGIN_ROOT}/knowledge/<pfad>.md`), Skills als erwähnte Skill-Namen (= Skill-Verzeichnisnamen, z.B. `flow`, `train`). Der Reader liest deshalb ein **optionales** Frontmatter-Feld `skills` / `knowledge` (Liste), und **fällt — wenn das jeweilige Feld fehlt — auf Body-Parsing zurück**. So funktioniert das Feature **heute ohne Editieren der Plugin-Dateien** (de-facto Body-Parsing) und bleibt zukunftssicher, falls später explizite Felder gepflegt werden. *Alternativen: rein Body-Parsing (heuristisch, simpler) oder rein Frontmatter (sauber, aber erfordert Plugin-Pflege).*
- **(b) Darstellung — eigene Sektion mit klickbaren Chips**, abgesetzt unter den bestehenden Metadaten-Badges (eine Sektion "Zugehörige Skills", eine "Zugehöriges Knowledge"); Chip-Stil konsistent zum bestehenden Badge-Look. *Alternativen: verlinkte Liste oder Inline-Badges.*
- **(c) Klick + Richtung — vorwärts UND rückwärts.** Vorwärts: Chip-Klick wechselt die Auswahl via bestehendem `loadDetail(kind, id)`. Rückwärts: Skill-/Knowledge-Detail listet die nutzenden Agenten als klickbare Chips. *Alternative: nur vorwärts (kleinerer Scope).*

## Verhalten

### Backend (Referenz-Auflösung — erweitert [[team-view-backend]])
1. Der **AgentFlowReader** ermittelt je Agent die zugehörigen **Skill-** und **Knowledge-Referenzen** und gibt sie als **aufgelöste, validierte id-Listen** zurück:
   - **Quelle Skills:** optionales Frontmatter-Feld `skills` (Liste von Skill-ids); fehlt es, werden im Agent-**Body** erwähnte **Skill-Verzeichnisnamen** (= existierende Skill-ids des Plugins) als Referenz erkannt.
   - **Quelle Knowledge:** optionales Frontmatter-Feld `knowledge` (Liste von Knowledge-ids); fehlt es, werden im Agent-**Body** vorkommende **Knowledge-Pfade** (`knowledge/<pfad>.md`, auch mit `${CLAUDE_PLUGIN_ROOT}/`-Präfix) zu Knowledge-ids normalisiert (id = Pfad unter `knowledge/` ohne `.md`).
2. **Nur existierende Ziele:** jede ermittelte Referenz wird gegen die tatsächlich vorhandenen Skill-/Knowledge-ids des Plugins abgeglichen; **nicht auflösbare** Referenzen werden **verworfen** (keine toten Links). Ergebnis je Liste: **dedupliziert** und **stabil sortiert**.
3. Das **Agent-Detail** (`GET /api/team/agent/:id`) enthält zusätzlich `relatedSkills: [{ id, name }]` und `relatedKnowledge: [{ id, name, group }]` (leere Listen, wenn keine auflösbaren Referenzen).
4. **Rückwärts-Referenz:** Das **Skill-** und **Knowledge-Detail** (`GET /api/team/skill/:id`, `GET /api/team/knowledge/:id`) enthält zusätzlich `usedByAgents: [{ id, name }]` — alle Agenten, deren aufgelöste Referenzen (Regel 1+2) dieses Ziel enthalten; dedupliziert, stabil sortiert, leere Liste wenn keiner.
5. **Konsistenz vorwärts/rückwärts:** Ist Skill/Knowledge `X` in `relatedSkills`/`relatedKnowledge` von Agent `A`, dann enthält `usedByAgents` von `X` den Agenten `A` — und umgekehrt (dieselbe Auflösungslogik, einmal pro Richtung angewandt).
6. **Degradation/Sicherheit:** Die Erweiterung ändert **nichts** an [[team-view-backend]] AC5–AC9 (Path-Traversal-Whitelist, 404-Verhalten, leere Listen ohne Plugin, AccessGuard, keine Secrets). Alle aufgelösten ids unterliegen derselben strengen id-Validierung; es werden **keine** Dateien außerhalb von `agents/`, `skills/`, `knowledge/` der Plugin-Root gelesen.

### Frontend (Darstellung + Navigation — erweitert [[team-view-frontend]])
7. Im **Agent-DetailPane** erscheinen unter den Metadaten-Badges zwei abgesetzte Sektionen: **"Zugehörige Skills"** (Chips aus `relatedSkills`) und **"Zugehöriges Knowledge"** (Chips aus `relatedKnowledge`). Jeder Chip zeigt den Anzeigenamen (`name`, ersatzweise `id`).
8. Ein Klick (Maus **oder** Tastatur: Enter/Space) auf einen Skill-Chip ruft `loadDetail('skill', id)` auf, auf einen Knowledge-Chip `loadDetail('knowledge', id)` — die bestehende Master-Detail-Navigation wechselt auf das Ziel; der entsprechende Nav-Eintrag wird aktiv (`aria-current`), ohne Voll-Reload der View.
9. Im **Skill-/Knowledge-DetailPane** erscheint eine Sektion **"Verwendet von"** mit Chips aus `usedByAgents`; Klick ruft `loadDetail('agent', id)` auf.
10. **Leerzustand pro Sektion:** Ist eine Liste leer, wird die jeweilige Sektion **nicht** gerendert (kein leerer Sektionskopf). Hat ein Agent weder Skill- noch Knowledge-Referenzen, sieht das DetailPane wie bisher aus.
11. Chips sind **echte, fokussierbare** Bedienelemente (Buttons) mit sichtbarem Fokusring (kein `outline:none`), Touch-Target ≥ 44 px Trefferfläche bzw. mind. 24 px Höhe mit ausreichendem Padding/Abstand, und Bedeutung nicht allein über Farbe (Label sichtbar). Es wird **kein** `dangerouslySetInnerHTML`/`innerHTML` verwendet; keine neue externe Bibliothek.

## Acceptance-Kriterien

### Backend (referenziert von Item „Backend")
- **AC1** — `GET /api/team/agent/:id` liefert zusätzlich `relatedSkills` (Array von `{ id, name }`) und `relatedKnowledge` (Array von `{ id, name, group }`). Beide nur mit **tatsächlich existierenden** Skill-/Knowledge-Zielen, **dedupliziert**, **stabil sortiert**; leere Arrays wenn keine auflösbar.
- **AC2** — Referenz-Quelle ist **Frontmatter mit Vorrang, Body-Fallback**: existiert das Frontmatter-Feld `skills`/`knowledge`, wird es verwendet; fehlt es, werden die Referenzen aus dem Agent-**Body** abgeleitet (Skills = erwähnte existierende Skill-ids; Knowledge = `knowledge/<pfad>.md`-Vorkommen, auch mit `${CLAUDE_PLUGIN_ROOT}/`-Präfix, normalisiert zur Knowledge-id ohne `.md`).
- **AC3** — Nicht auflösbare Referenzen (Ziel-id existiert nicht im Plugin) werden **verworfen** — `relatedSkills`/`relatedKnowledge` enthalten **keine** toten Links.
- **AC4** — `GET /api/team/skill/:id` und `GET /api/team/knowledge/:id` liefern zusätzlich `usedByAgents` (Array von `{ id, name }`), dedupliziert + stabil sortiert; leeres Array wenn kein Agent dieses Ziel referenziert.
- **AC5** (Konsistenz) — Vorwärts- und Rückwärts-Referenz sind konsistent: Enthält `relatedSkills`/`relatedKnowledge` von Agent `A` das Ziel `X`, enthält `usedByAgents` von `X` den Agenten `A` (und umgekehrt).
- **AC6** (Security/Floor — unverändert geerbt) — Die strenge id-Whitelist und der Path-Traversal-Schutz aus [[team-view-backend]] AC5 bleiben für alle (auch intern aufgelösten) ids wirksam; es werden **keine** Dateien außerhalb `agents/`/`skills/`/`knowledge/` gelesen; **keine** Secrets in der Response; beide Endpunkte bleiben hinter dem AccessGuard ([[team-view-backend]] AC9). Ohne Plugin-Root degradiert alles zu leeren Listen / 404 ([[team-view-backend]] AC7) — **kein** 500/Crash.

### Frontend (referenziert von Item „Frontend")
- **AC7** — Im Agent-DetailPane werden `relatedSkills` als Sektion **"Zugehörige Skills"** und `relatedKnowledge` als Sektion **"Zugehöriges Knowledge"** mit je einem Chip pro Eintrag (Anzeigename, ersatzweise `id`) gerendert; eine leere Liste rendert **keine** Sektion.
- **AC8** — Klick (Maus **oder** Tastatur Enter/Space) auf einen Skill-Chip ruft `loadDetail('skill', id)`, auf einen Knowledge-Chip `loadDetail('knowledge', id)`; die View zeigt danach das Ziel-Detail und markiert den zugehörigen Nav-Eintrag als aktiv (`aria-current`) — **ohne** Voll-Reload der Übersicht.
- **AC9** — Im Skill-/Knowledge-DetailPane wird `usedByAgents` als Sektion **"Verwendet von"** mit klickbaren Agent-Chips gerendert; Klick ruft `loadDetail('agent', id)`; leere Liste → keine Sektion.
- **AC10** (A11y/Floor) — Chips sind fokussierbare Bedienelemente mit **sichtbarem Fokusring** (kein `outline:none`), per Tastatur (Tab + Enter/Space) aktivierbar, Bedeutung nicht allein über Farbe, ausreichende Trefferfläche/Abstand; **kein** `dangerouslySetInnerHTML`/`innerHTML`; **keine** neue externe Bibliothek; keine neuen Secrets im Bundle; es werden ausschließlich die `/api/team*`-Endpunkte aufgerufen.

## Verträge
- **Backend — `GET /api/team/agent/:id`** → `200 { …agentMeta, body, relatedSkills: [{id,name}], relatedKnowledge: [{id,name,group}] }`.
- **Backend — `GET /api/team/skill/:id`** → `200 { …skillMeta, body, usedByAgents: [{id,name}] }`.
- **Backend — `GET /api/team/knowledge/:id`** → `200 { …knowledgeMeta, body, usedByAgents: [{id,name}] }`.
- Übersicht `GET /api/team` bleibt **unverändert** (body-frei, keine Referenzfelder — diese gehören ins Detail).
- **Boundary `AgentFlowReader`** — neue interne Auflösung „Agent → {skillIds, knowledgeIds}" (Frontmatter-mit-Body-Fallback, gegen vorhandene ids validiert) + Umkehrung „Ziel → nutzende Agenten"; injizierbare FS-Deps wie bestehend; keine neuen FS-Pfade außerhalb der drei Kind-Verzeichnisse.
- **Frontend — `client/src/TeamView.jsx`** — `DetailPane` rendert die neuen Sektionen/Chips und ruft das bestehende `loadDetail(kind, id)` für die Navigation; keine neue Route, kein neuer Endpunkt-Pfad.

## Edge-Cases & Fehlerverhalten
- Agent ohne jede auflösbare Referenz → keine Skill-/Knowledge-Sektion (AC7/AC10), übriges Detail unverändert.
- Body erwähnt einen Knowledge-Pfad, der nicht (mehr) existiert → Referenz verworfen (AC3); kein toter Chip.
- Body erwähnt ein Wort, das zufällig wie eine Skill-id aussieht, aber kein Skill ist → keine Referenz (Abgleich gegen existierende ids, AC3).
- Frontmatter `skills`/`knowledge` mit Einträgen, die nicht existieren → verworfen (AC3).
- Knowledge-id mit Sub-Pfad (`frameworks/spring-boot-3`) → korrekt aufgelöst + per Chip navigierbar (geerbte id-Validierung lässt Slash für knowledge zu, [[team-view-backend]]).
- Plugin-Root fehlt → Detail-Aufruf 404, Übersicht leer; keine Referenzfelder, kein Crash (geerbt aus [[team-view-backend]] AC7).
- Doppelte Erwähnung desselben Ziels im Body → genau **ein** Chip (Dedup, AC1/AC4).

## NFRs
- **Sicherheit (Floor):** geerbt aus [[team-view-backend]] (Path-Traversal-Whitelist, read-only, AccessGuard, keine Secrets) und [[team-view-frontend]] (kein `dangerouslySetInnerHTML`/`innerHTML`, keine externe Lib, nur `/api/team*`).
- **A11y (WCAG 2.1 AA):** Chips fokussierbar, Tastatur-aktivierbar, sichtbarer Fokusring, Bedeutung nicht nur über Farbe (AC10).
- **Robustheit:** vollständige Degradation ohne Plugin; tote Referenzen werden nie angezeigt.
- **Performance:** Referenz-Auflösung im Detail-Request; Übersicht bleibt body-/referenzfrei.

## Nicht-Ziele
- **Kein** Editieren/Schreiben von Agenten/Skills/Knowledge (strikt read-only).
- **Keine** Anzeige von Referenzen in der **Übersicht** (`GET /api/team`) — nur im Detail.
- **Keine** Live-Ausführung von Agenten/Skills.
- **Keine** neue externe Markdown-/Graph-/Router-Bibliothek, **keine** neue DB.
- **Keine** Scroll-Korrektur (das ist [[team-detail-scroll]]).

## Abhängigkeiten
- [[team-view-backend]] — wird um die Referenz-Auflösung (Detail-Felder) erweitert; **Backend-Item zuerst** (Frontend konsumiert die neuen Felder).
- [[team-view-frontend]] — wird um Chip-Sektionen + Navigation erweitert.
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
