---
id: team-view-backend
title: Team-Ansicht — Backend-Boundary (AgentFlowReader + /api/team)
status: draft
version: 1
---

# Spec: Team-Ansicht — Backend-Boundary (`team-view-backend`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).

## Zweck
Stellt das agent-flow-„Team" — alle **Agenten**, **Skills** und **Knowledge-Packs** des installierten Plugins — **read-only** über das Backend bereit: eine Übersicht (Metadaten ohne Body) und ein Detail-Endpunkt (Metadaten + roher Markdown-Body). Liefert die Datenbasis für die Team-Ansicht im Frontend ([[team-view-frontend]]). Schreibt nichts, führt nichts aus.

## Verhalten
1. Ein **AgentFlowReader**-Boundary löst die Plugin-Root des installierten agent-flow-Plugins auf und liest daraus drei Kinds:
   - **Agent** — `<plugin>/agents/*.md`: YAML-Frontmatter (`name`, `description`, `tools`, `model`) + Markdown-Body.
   - **Skill** — `<plugin>/skills/*/SKILL.md`: Frontmatter (`name`, `description`) + Markdown-Body; die `id` ist der Verzeichnisname.
   - **Knowledge** — `<plugin>/knowledge/**/*.md` rekursiv (inkl. Unterordner wie `frameworks`, `build`, `migration`, `quality`, `_meta`): Markdown-Pack; **Anzeigename** = erste H1 (`# …`) des Dokuments, ersatzweise der Dateiname (ohne `.md`); **group** = Name des direkten Unterordners unter `knowledge/`, bzw. `core` für Dateien direkt unter `knowledge/`.
2. **Plugin-Root-Auflösung** analog `docker-entrypoint.sh`: ENV-Override (z.B. `AGENT_FLOW_PLUGIN_ROOT`) hat Vorrang; sonst das (neueste) Verzeichnis aus `find $HOME/.claude/plugins/cache/agent-flow -mindepth 2 -maxdepth 2 -type d`. Muss lokal **und** im Container funktionieren.
3. **GET /api/team** liefert die **Übersicht**: drei Listen (`agents`, `skills`, `knowledge`) mit Metadaten je Eintrag, **ohne** Body. Reihenfolge stabil (z.B. alphabetisch je Kind; Knowledge zusätzlich nach `group`).
4. **GET /api/team/:kind/:id** liefert das **Detail**: die Metadaten des Eintrags **plus** seinen rohen Markdown-`body`. `kind ∈ {agent, skill, knowledge}`.
5. **Degradation:** Fehlt die Plugin-Root oder ein Kind-Verzeichnis, liefert die Übersicht **leere Listen** und gibt **200** zurück (kein Fehler, kein Crash). Ein vorhandener Eintrag ohne lesbaren Body liefert einen leeren `body`-String, ebenfalls 200.
6. Beide Endpunkte sind **read-only** und sitzen hinter dem bestehenden **AccessGuard** auf `/api/*` (Verdrahtung in `server.js` analog zu den bestehenden Routern wie `statusRouter`).
7. Optionales In-Memory-Caching der gelesenen Quelle ist erlaubt (Quelle ändert sich selten), aber nicht zwingend; es darf das Degradations- und Sicherheitsverhalten nicht verändern.

## Acceptance-Kriterien
- **AC1** — `GET /api/team` antwortet **200** mit `{ agents: […], skills: […], knowledge: […] }`. Jeder Agent-Eintrag hat `{ id, name, description, model, tools }`, jeder Skill-Eintrag `{ id, name, description }`, jeder Knowledge-Eintrag `{ id, name, group }`. **Kein** Eintrag in der Übersicht enthält einen `body`.
- **AC2** — Der AgentFlowReader parst Frontmatter korrekt: aus einer Agent-Datei werden `name`, `description`, `tools`, `model` als Felder extrahiert und der Markdown-Body (alles nach dem Frontmatter) getrennt bereitgestellt; für Skills analog `name`, `description`.
- **AC3** — Knowledge wird rekursiv (inkl. Unterordner) gelesen; der Anzeigename stammt aus der ersten H1 des Dokuments, ersatzweise aus dem Dateinamen; `group` ist der direkte Unterordner-Name bzw. `core` für Dateien direkt unter `knowledge/`.
- **AC4** — `GET /api/team/:kind/:id` antwortet für ein existierendes `kind ∈ {agent, skill, knowledge}` und gültige `id` mit **200** und `{ …meta, body }`, wobei `body` der **rohe** Markdown-Inhalt des Eintrags ist.
- **AC5** (Security/Path-Traversal) — `:id` wird **vor** jedem Dateizugriff streng gegen eine Whitelist/Regex validiert (nur erlaubte Zeichen, **kein** `..`, **kein** `/` oder `\`, kein absoluter Pfad). Jeder Versuch eines Path-Traversal (`..`, eingebettete Slashes, Null-Byte) führt zu **404** (oder 400), **niemals** zu einem Lesezugriff außerhalb des jeweiligen Kind-Verzeichnisses.
- **AC6** — Unbekanntes `kind` oder unbekannte (aber syntaktisch gültige) `id` liefert **404**.
- **AC7** (Degradation) — Fehlt die Plugin-Root (kein Plugin installiert / ENV-Override zeigt ins Leere), liefert `GET /api/team` **200** mit drei **leeren** Listen; ein Detail-Aufruf auf eine dann nicht existente `id` liefert **404**. Es wird **kein** 500 geworfen und der Prozess crasht nicht.
- **AC8** (Security/Secrets) — Weder Übersicht noch Detail-Response enthalten Secrets, Tokens oder Pfade ausserhalb der gelesenen Markdown-Inhalte/Metadaten; es werden keine Dateien ausserhalb von `agents/`, `skills/`, `knowledge/` der aufgelösten Plugin-Root gelesen.
- **AC9** — Beide Endpunkte sind in `server.js` hinter dem bestehenden AccessGuard auf `/api/*` verdrahtet (Muster wie `statusRouter`); ein Request ohne gültigen Access-Nachweis erreicht die Handler nicht.

## Verträge
- **Boundary `AgentFlowReader`** (ESM, async): löst Plugin-Root auf (ENV-Override → Cache-Glob), listet + parst die drei Kinds, gibt Übersichts- und Detail-Daten zurück; injizierbare FS-/Resolver-Deps für Tests (analog `WorkspaceScanner` mit `fsDeps`).
- **`GET /api/team`** → `200`
  ```
  {
    agents:    [{ id, name, description, model, tools }],
    skills:    [{ id, name, description }],
    knowledge: [{ id, name, group }]
  }
  ```
  `tools` ist die Liste/Zeichenkette aus dem Frontmatter (so wie dort notiert); leere Listen bei fehlender Quelle.
- **`GET /api/team/:kind/:id`** → `200 { …meta, body }` | `404` (unbekanntes kind/id oder Traversal-Versuch).
  - `:kind` ∈ `{agent, skill, knowledge}` (Singular).
  - `:id` validiert gegen Regex-Whitelist (z.B. `^[a-zA-Z0-9._-]+$`), kein `..`, kein Slash/Backslash, kein Null-Byte.
  - `body` = roher Markdown-String (kein gerendertes HTML).
- **Verdrahtung** in `server.js`: `app.use(teamRouter({ agentFlowReader }))` hinter `app.use('/api', accessGuard)` — analog zur bestehenden Router-Reihe.

## Edge-Cases & Fehlerverhalten
- Plugin-Root nicht auflösbar → leere Listen, 200 (AC7).
- Einzelne Datei nicht lesbar/parsbar → Eintrag wird übersprungen bzw. mit leerem `body` zurückgegeben; der Endpunkt bleibt 200.
- Frontmatter fehlt/teilweise → fehlende Felder als leerer String/leere Liste; kein Crash.
- `:id` mit `..`, `/`, `\`, Null-Byte oder sonstigen unerlaubten Zeichen → 404 (oder 400), kein Dateizugriff (AC5).
- Unbekanntes `:kind` → 404 (AC6).
- Sehr viele/grosse Knowledge-Dateien → Übersicht bleibt body-frei (günstig); Detail liest genau eine Datei.

## NFRs
- **Sicherheit (Floor):** Path-Traversal-Schutz bei `:id` (Regex-Whitelist, Begrenzung auf das jeweilige Kind-Verzeichnis); keine Secrets in Response/Log; read-only (kein Schreiben/Ausführen); hinter AccessGuard.
- **Robustheit:** vollständige Degradation ohne Plugin (leere Listen statt Fehler).
- **Performance:** Übersicht ohne Body; optionales In-Memory-Cache erlaubt (nicht zwingend).
- **Portabilität:** Plugin-Root-Auflösung funktioniert lokal und im Container (ENV-Override respektiert).

## Nicht-Ziele
- **Kein** Editieren/Schreiben von Agenten/Skills/Knowledge (strikt read-only).
- **Keine** Live-Ausführung von Agenten/Skills aus diesem Endpunkt.
- **Keine** neue Datenbank/Persistenz (live aus dem Dateisystem, ADR-005-konform — nur Lese-Read-Model).
- **Kein** Markdown-Rendering im Backend (Body bleibt roh; Rendering ist Frontend-Sache, [[team-view-frontend]]).

## Abhängigkeiten
- [[access-and-guardrails]] (AccessGuard auf `/api/*`, unverändert).
- Liefert die Datenbasis für [[team-view-frontend]].
- Muster: bestehende Reader/Router (`WorkspaceScanner`, `statusRouter`) in `src/`.
