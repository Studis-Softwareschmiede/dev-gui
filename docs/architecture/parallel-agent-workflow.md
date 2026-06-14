# Parallel Agent Workflow — Architektur-Record (Hot-Spot-Entkopplung)

> **Durable Architecture Record.** Source of Truth dafür, **wie mehrere Agenten nachhaltig parallel** an diesem Repo arbeiten, ohne sich in Merge-Konflikten zu blockieren. Begründet das Problem an der Wurzel und legt die vier Gegenmaßnahmen fest. Die umsetzbaren Teile tragen **nummerierte Acceptance-Kriterien**; die referenzierenden Board-Items zeigen auf AC-Nummern hier.
>
> **Sicherheits-Floor:** Dieses Dokument ändert **kein** beobachtbares Verhalten und **keine** Endpunkt-/Auth-Semantik. Alle Migrationen sind verhaltensneutral (reine Verdrahtungs-/Struktur-Refactorings) und unterliegen weiterhin dem generischen Drift-/Security-Gate aus `coder`/`reviewer`.

---

## 1. Diagnose — die Wurzel sind wenige zentrale Sammel-Dateien

Im Repo arbeiten regelmäßig **mehrere Agenten parallel** über Feature-Branches → PR → squash-merge auf `main`. Die wiederkehrende Reibung ist **nicht** breit gestreut: **~90 % der Merge-Konflikte** entstehen an **wenigen zentralen „Sammel-Dateien"**, die **jedes** Feature anfasst. Disjunkte Feature-Dateien (eigene Komponente, eigene Spec, eigener Test) kollidieren praktisch **nie**.

Die belegten Hot-Spots in diesem Repo:

| Hot-Spot | Warum jedes Feature ihn anfasst | Konflikt-Muster |
|---|---|---|
| `server.js` | Jeder neue Backend-Endpunkt fügt einen `import …Router` **und** ein `app.use(…)` hinzu — heute **~30 manuelle Registrierungen** in einer Datei. | Zwei Branches fügen Zeilen am selben Import-Block / `app.use`-Block hinzu → Konflikt. |
| `client/src/AppShell.jsx` | Jede neue View fügt einen `import …View`, ggf. eine Kachel **und** eine `{view === 'x' && <XView/>}`-Zeile im View-Switch hinzu. | Gleicher Block, gleiche Stelle → Konflikt. |
| `eslint.config.js` | Globals/Overrides je Feature. | Selten, aber dieselbe Klasse. |
| `docker-compose.yml` | Env/Service-Erweiterungen je Feature. | Dieselbe Klasse. |
| `package.json` | Dependencies/Scripts je Feature. | Dieselbe Klasse (durch `package-lock.json` verschärft). |
| GitHub-Board | Mehrere Agenten am selben Item/Status. | Koordinations-, kein Datei-Konflikt. |

**Schlussfolgerung:** Wer die **manuellen zentralen Listen** (Router-Registrierung, View-Switch) durch **konventions-basiertes Auto-Laden** ersetzt, entfernt die häufigste Konfliktquelle **dauerhaft** — ein neues Feature legt dann **nur eigene, disjunkte Dateien** an und fasst **keine** Sammel-Datei mehr an. Das ist der größte Hebel und Kern dieses Records (Schicht 1).

---

## 2. Die vier Schichten

### Schicht 1 — Hot-Spot-Entkopplung via Auto-Discovery (größter Hebel)

Zentrale **manuelle** Listen werden durch **konventions-basiertes Laden** ersetzt. Ziel: ein neues Feature registriert sich **selbst per Konvention**, niemand editiert die Sammel-Datei.

**Backend (Router-Auto-Registry).** Statt in `server.js` je Router `import` + `app.use(…)` zu pflegen, werden Router-Module aus einem Konventions-Verzeichnis (z.B. `src/routers/*.js`) **automatisch** entdeckt und registriert (Glob/Index-Barrel). Ein neues Feature legt **eine eigene Router-Datei** an; `server.js` (bzw. der Bootstrap) bleibt unverändert. Jeder Router exportiert eine **einheitliche Mount-Signatur** (Factory, die die benötigten Boundaries/Dependencies als Argument bekommt — kein globaler Service-Locator), damit die Dependency-Injektion aus `server.js` (Stores, Reader, Orchestratoren) erhalten bleibt. **Verhaltens-neutral:** identische Pfade, identische Reihenfolge-Garantien dort, wo sie nötig sind (z.B. `/api`-AccessGuard **vor** allen Routern; SPA-Catch-All **nach** allen Routern). → **Spec-AC: AC1–AC6.**

**Frontend (View-Registry).** Statt in `AppShell.jsx` je View `import` + Kachel + `{view === 'x' && …}` zu pflegen, registriert sich jede View über ein **Konventions-/Manifest-Verfahren** (jede View deklariert `id`, optional Kachel-Metadaten, Komponente — an einem Ort je View). Die App-Shell liest das Manifest und rendert datengetrieben; der bestehende Hash-Router (`useHashRouter`) bleibt. **Verhaltens-/UX-neutral:** identische Routen, identische Kachel-Reihenfolge, identische A11y; die bestehenden View-spezifischen AC (app-shell-navigation, settings-shell, team-view-frontend, dashboard-deployment-tile) bleiben erfüllt. → **Spec-AC: AC7–AC12.**

### Schicht 2 — Worktree-Isolation pro Agent (Standard-Arbeitsweise)

Jeder parallele Agent arbeitet in einem **eigenen `git worktree`** (eigenes Verzeichnis + eigener Branch) statt im selben Haupt-Tree → keine Working-Tree-Kollision zwischen parallelen Sessions. Der bestehende Test-Lauf muss gegen **vergiftete Caches/Haste-Map-Duplikate** aus Worktree-Verzeichnissen geschützt sein (sonst ziehen fremde, evtl. rote Tests aus anderen Branches den globalen Test-Lauf mit herunter).

**Aktueller Stand (bereits in `jest.config.js`):** `testPathIgnorePatterns` **und** `modulePathIgnorePatterns` schließen `/.claude/worktrees/` aus; `eslint.config.js` ignoriert `.claude/worktrees/` ebenfalls. Diese Linie ist die **bindende Konvention**: Worktrees liegen unter `.claude/worktrees/`, und jeder Cache-/Scan-/Lint-Pfad muss sie ausschließen. → **Spec-AC: AC13–AC15** härten + verriegeln genau diese Garantie (Regression-Schutz), damit ein künftiger Config-Edit sie nicht still entfernt.

> Die **Arbeitsweise** „jeder Agent in eigenem Worktree" ist primär `agent-flow`-Methodik (siehe §4).

### Schicht 3 — CI-Gates als hartes Netz

`lint` + `test` + `secret-scan` sollen **required checks** der Branch-Protection sein — ein Branch kann nur mergen, wenn alle drei grün sind. Damit fängt das harte Netz genau die Drift ab, die trotz Disziplin durchrutscht.

**Aktueller Stand:** `secret-scan` (gitleaks) und `lint` sind **bereits** Jobs in `.github/workflows/build.yml`; `image` hängt an `needs: [secret-scan, lint]` (lint-Gate live seit **f20205d**, „fix(ci): RetroTrend-Lint config-seitig beheben + CI-Lint-Gate (#206)"). **Offen:** ein **`test`-Job** im CI (führt `npm test` aus) als gleichrangiges Gate **und** das Setzen/Dokumentieren der **Branch-Protection required-checks** (lint + test + secret-scan). → **Spec-AC: AC16–AC19.**

### Schicht 4 — Disjunkte Scopes + kurzlebige Branches (Koordination)

Reine **Arbeitsweise/Disziplin** (kein Repo-Artefakt), hier als verbindliche Konvention festgehalten:

- Jeder Agent bekommt einen **disjunkten Item-/Datei-Scope**.
- Items, die denselben **Hot-Spot** anfassen, werden **serialisiert** statt parallelisiert (solange Schicht 1 noch nicht alle Hot-Spots entkoppelt hat).
- **Kleine Items**, **kurze Branch-Lebensdauer**, regelmäßiges **Rebase von `main`** in länger lebende Branches.

> Wie Schicht 2 ist auch Schicht 4 primär `agent-flow`-Methodik (siehe §4).

---

## 3. Priorisierung

| Prio | Schicht | Was | Begründung |
|---|---|---|---|
| **P1** | 1 — Backend | Router-Auto-Registry (`server.js` → `src/routers/`-Auto-Discovery) | Größter Hebel: entfernt den dichtesten Hot-Spot (~30 Registrierungen). |
| **P1** | 1 — Frontend | View-Registry (`AppShell.jsx` → Manifest/Konvention) | Zweitdichtester Hot-Spot; jede View fasst die Datei an. |
| **P2** | 2 | jest-Worktree-Isolation härten/verriegeln | Schützt den Test-Lauf vor parallelen Worktrees; Basis steht, Regression-Schutz fehlt. |
| **P2** | 3 | CI-Test-Gate + Branch-Protection required-checks | Hartes Netz vervollständigen; baut auf dem gelandeten lint-Gate auf. |

Schicht 2 (Worktree als Standard) und Schicht 4 (Scope-Disziplin/kurzlebige Branches) sind **Arbeitsweise** — kein eigenes Code-Item hier (siehe §4).

---

## 4. Methodische Teile gehören zusätzlich in agent-flow

Schicht 2 (Worktree als Standard-Arbeitsweise) und Schicht 4 (disjunkte Scopes, kleine/kurzlebige Branches, Rebase-Disziplin) sind **Fabrik-übergreifende Methodik** — sie wirken am stärksten, wenn sie **zusätzlich** in die globalen `agent-flow` Knowledge-Packs/Skills einfließen (Orchestrator vergibt disjunkte Scopes; jeder Sub-Agent läuft im eigenen Worktree). Das ist ein eigenes **`/retro`-Thema** und wird **hier nicht umgesetzt** — dieser Record hält nur den projekt-lokalen Anteil fest und verweist auf die Methodik.

---

## 5. Acceptance-Kriterien

> Nur die **umsetzbaren** Teile tragen AC. Schicht 4 (reine Disziplin) trägt keine.

### Schicht 1 — Backend Router-Auto-Registry

- **AC1** — Backend-Router werden **konventions-basiert** aus einem dedizierten Verzeichnis (z.B. `src/routers/`) entdeckt und montiert; `server.js` (bzw. der Bootstrap) enthält **keine** pro-Router `import`-Zeile und **kein** pro-Router `app.use(…)` mehr (Grep: die heutigen ~30 Einzel-Registrierungen sind weg).
- **AC2** — Ein **neuer** Endpunkt lässt sich hinzufügen, indem **ausschließlich** eine **neue** Datei im Konventions-Verzeichnis angelegt wird; **keine** bestehende Sammel-Datei (`server.js`) wird dafür geändert.
- **AC3** — Jeder Router-Modul exportiert eine **einheitliche Mount-Signatur** (Factory, die ihre Dependencies als Argument erhält); es gibt **keinen** globalen Service-Locator/Singleton-Import für Boundaries.
- **AC4** — Alle **heute existierenden** Router-Pfade bleiben **byte-identisch** erreichbar (gleiche Methode + Pfad + Response-Shape); kein Endpunkt entfällt, keiner ändert Verhalten (Endpunkt-Inventar = Kommentar-Kopf in `server.js` bzw. bestehende Specs).
- **AC5** — Reihenfolge-Invarianten bleiben gewahrt: der `/api`-AccessGuard greift **vor** allen `/api/*`-Routern; der SPA-Catch-All (`/*splat`) wird **nach** allen API-Routern registriert (API-404 wird nicht maskiert).
- **AC6** — **Verhaltens-neutral & sicher:** keine neuen Secrets, keine geänderte Auth/Audit-Semantik; die bestehende Test-Suite bleibt grün; Auto-Discovery scannt **keine** `node_modules/`/`.claude/worktrees/`-Pfade.

### Schicht 1 — Frontend View-Registry

- **AC7** — Views werden über ein **Manifest/Konventions-Verfahren** registriert (je View: `id`, Komponente, optional Kachel-Metadaten an **einem** Ort); `AppShell.jsx` enthält **keine** pro-View `{view === 'x' && <XView/>}`-Kette und **keinen** pro-View `import` mehr.
- **AC8** — Eine **neue** View lässt sich hinzufügen, ohne `AppShell.jsx` zu editieren (nur die neue View-Datei + ihr Manifest-Eintrag/Selbst-Registrierung).
- **AC9** — Alle **heute existierenden** Routen funktionieren unverändert: `#/factory`, `#/github`, `#/vps`, `#/cloudflare`, `#/deployments`, `#/settings`, `#/team`, `#/retro`, `#/retro-trend`, Wurzel `#/` → Panel, unbekannte Route → Panel.
- **AC10** — Das Einstiegs-Panel zeigt **genau dieselben sechs Kacheln** in **derselben Reihenfolge** (GitHub, VPS, Cloudflare, Fabrik (dev-gui), Team, Deployments); Settings/Retro/Retro-Trend bleiben **Nicht-Kacheln**. Die bestehenden AC von `app-shell-navigation`, `settings-shell`, `team-view-frontend`, `dashboard-deployment-tile` bleiben erfüllt.
- **AC11** — Der Terminal-Lifecycle bleibt unverändert: `FactoryView` wird **nur** gerendert, solange die Factory-Route aktiv ist (kein Hintergrund-Mount).
- **AC12** — **UX-/A11y-neutral & sicher:** sichtbarer Fokus, `aria-current`, Touch-Targets ≥ 44 px bleiben; keine neuen Secrets, kein neuer Backend-Endpunkt, keine view-spezifische Autorisierung. Die Frontend-Tests bleiben grün.

### Schicht 2 — jest-Worktree-Isolation (härten + verriegeln)

- **AC13** — `jest.config.js` schließt Worktree-Pfade (`/.claude/worktrees/`) sowohl aus dem **Test-Scan** (`testPathIgnorePatterns`) als auch aus der **Haste-/Modul-Map** (`modulePathIgnorePatterns`) aus; ein paralleler Worktree mit eigenen (auch roten) Tests beeinflusst den `main`-Test-Lauf **nicht**.
- **AC14** — Ein **Regressions-Test/Check** verriegelt diese Garantie: das Entfernen eines der beiden Ignore-Patterns würde nachweislich auffallen (z.B. ein Test, der prüft, dass die Konfig die Worktree-Pfade ausschließt) — die Garantie ist nicht mehr nur „durch Aufmerksamkeit" geschützt.
- **AC15** — Die Worktree-Ausschluss-Konvention (`.claude/worktrees/`) ist **konsistent** über die Tooling-Configs: jest (Scan + Modul-Map) und eslint (`ignores`); keine neue Config-Quelle führt Worktree-Pfade wieder ein.

### Schicht 3 — CI-Test-Gate + Branch-Protection

- **AC16** — `.github/workflows/build.yml` enthält einen **`test`-Job**, der `npm test` (bzw. `npm ci` + `npm test`) ausführt; der Job läuft auf demselben Trigger wie `lint`/`secret-scan`.
- **AC17** — Der `image`-Job hängt an **`needs: [secret-scan, lint, test]`** — kein Image wird gebaut/gepusht, wenn der Test-Job rot ist.
- **AC18** — Die **Branch-Protection** für `main` ist dokumentiert **und** so gesetzt, dass `lint`, `test` und `secret-scan` **required checks** sind (kein Merge ohne grün). Die Doku nennt den genauen Check-Namen + wie er gesetzt wird.
- **AC19** — **Sicher & kosten-bewusst:** der Test-Job verwendet **kein** Anthropic-API/`-p` und keine Secrets im Klartext; er bricht bei rotem Test ab (Exit ≠ 0); Sonar/teure Scans bleiben außerhalb dieses per-Push-Gates (ökonomische Cadence unberührt).

---

## 6. Verträge / betroffene Artefakte

- **Backend:** neues Konventions-Verzeichnis (z.B. `src/routers/`) + verhaltens-neutrale Migration aller heutigen Router (`src/*Router.js`); `server.js` verliert die manuellen Registrierungen, behält die Boundary-/Dependency-Konstruktion (Stores, Reader, Orchestratoren) als Injektions-Quelle.
- **Frontend:** View-Manifest/Selbst-Registrierung + verhaltens-neutrale Migration aller heutigen Views; `AppShell.jsx` rendert datengetrieben.
- **Tooling:** `jest.config.js` (Ignore-Härtung + Regressions-Check), `.github/workflows/build.yml` (`test`-Job + `needs`), Branch-Protection (gh/Doku).
- **Keine** Änderung an Endpunkten, Auth, Audit, Krypto, Datei-Schemata.

## 7. Edge-Cases & Fehlerverhalten

- **Router mit Reihenfolge-Abhängigkeit** (AccessGuard vor `/api`; SPA-Catch-All zuletzt): die Auto-Discovery darf diese Invarianten nicht brechen → explizit über Mount-Phasen/Konvention sichergestellt (AC5).
- **Fehlerhaftes Router-Modul** (Import-/Mount-Fehler): Boot bricht **fail-fast** ab (kein stilles Überspringen eines Endpunkts), damit ein fehlender Endpunkt nicht unbemerkt bleibt.
- **Worktree mit eigener `src/`-Kopie**: darf Modul-Auflösung/Caches nicht vergiften (AC13–AC15).
- **Roter Test im CI**: blockiert Image **und** Merge (AC17/AC18).

## 8. Nicht-Ziele

- **Keine** Umsetzung in diesem Lauf — dies ist ein **Verankerungs-Record** (Spec + Items).
- **Keine** Änderung beobachtbaren Verhaltens / keine neuen Endpunkte / kein UX-Redesign.
- **Keine** Aufnahme der `agent-flow`-Methodik (Schicht 2 Arbeitsweise, Schicht 4) in dieses Repo — das ist `/retro`/Knowledge-Pack-Arbeit (§4).
- **Keine** Entkopplung von `docker-compose.yml`/`package.json`/`eslint.config.js` in diesem Record (seltener; bei Bedarf späterer Record) — Fokus liegt auf den zwei dominanten Hot-Spots.

## 9. Abhängigkeiten

- Frontend-View-Registry berührt die bestehenden Specs `app-shell-navigation`, `settings-shell`, `team-view-frontend`, `dashboard-deployment-tile` (deren AC bleiben erfüllt — AC10).
- CI-Test-Gate baut auf dem gelandeten lint-Gate (f20205d) in `.github/workflows/build.yml` auf.
- jest-Härtung steht auf der bestehenden Worktree-Ignore-Linie in `jest.config.js`/`eslint.config.js`.
</content>
</invoke>
