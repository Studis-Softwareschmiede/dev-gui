---
id: team-knowledge-add
title: Team-Train — neuen Knowledge Space anlegen (Beschreibung → Quellen-Suche → Bestätigen → train --bootstrap)
status: draft
version: 3
---

# Spec: Neuen Knowledge Space anlegen aus der Teamsicht  (`team-knowledge-add`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge. Source of Truth für coder/tester/reviewer.
>
> **Erweitert [[team-train-trigger]].** Im Train-Popup gibt es einen Button „Neuen Knowledge Space anlegen". Der Owner beschreibt in Worten, was angelegt werden soll; **Claude sucht im Hintergrund offizielle Quellen** und bietet sie zur Auswahl an; nach OK wird der `--bootstrap`-Modus des Train damit gespeist und das neue Pack als PR + Approve angelegt.
>
> **Revision v2 (Owner 2026-06-19):** Statt manuell Quell-URLs einzutippen (v1) gibt der Owner eine **Beschreibung** ein; ein **headless Claude-Schritt** ermittelt **offizielle Quellen** und listet sie zur Bestätigung. Erst die bestätigten Quellen speisen `train --bootstrap`.
>
> **Revision v3 (architekt-Review 2026-06-19 — `APPROVE-WITH-CONDITIONS`):** Die neue headless, web-fähige Helfer-Boundary ist tragfähig und doktrin-vereinbar — unter den unten als „Architektur-Auflagen (bindend)" verankerten Bedingungen. Wesentlich: **eigener** `KnowledgeSourceService` (kein `kind` in `AssistService`), **exklusive Tool-Allowlist** (nur `WebSearch` — `WebFetch` bewusst weggelassen, das Fetchen macht erst der train-Agent → kein SSRF im dev-gui-Prozess), **Doktrin-Nachführung** in `CLAUDE.md`/`architecture.md`, Audit-Eintrag, backend-seitige URL-Validierung, Timeout+1-Retry.

## Zweck

Über den Train-Button soll der Owner nicht nur Vorhandenes trainieren, sondern auch einen **neuen Knowledge Space** komplett aus der GUI anlegen: Beschreibung eingeben → Claude schlägt **offizielle/autoritative Quellen** vor → der Owner bestätigt sie → der Train legt das Pack daraus an (PR + Mensch-Approve).

## Kontext / Designentscheidungen (bindend)

- **Owner-Vision 2026-06-19 (Ablauf):**
  1. Klick auf **Train** → Popup öffnet.
  2. Im Popup ein Button **„Neuen Knowledge Space anlegen"**.
  3. Klick → Eingabefeld für eine **Beschreibung** (was soll angelegt werden).
  4. Im **Hintergrund läuft Claude** los und sucht **offizielle Quellen**.
  5. Die gefundenen Quellen werden **unten aufgelistet** und mit **OK** bestätigt (Auswahl möglich).
  6. Mit diesen Angaben wird **agent-flow Train (`--bootstrap`)** gespeist → neuer Knowledge Space angelegt.
- **Wiederverwendung der bestehenden Headless-Boundary.** Die Quellen-Suche nutzt das **`AssistService`-Muster** (`claude -p`, headless, einmalig, **kein** JobLock, Eingabe via **stdin**, strukturiertes JSON zurück) — die bewusste Doktrin-Ausnahme aus `fabric-intake-dialog.md` (AC11). Der PTY-/Flow-Pfad bleibt unberührt. **Neu** gegenüber dem Refine-Helfer: dieser Helfer braucht **Web-Zugriff** (WebSearch/WebFetch). Das ist eine **neue headless Web-Oberfläche** → **architekt-Abnahme** nötig (siehe Offene Fragen).
- **Auslösen weiter über den PTY-Schreibpfad.** Das eigentliche Anlegen läuft wie gehabt über `POST /api/command` → `CommandService` (Allowlist `/agent-flow:train`, einzeilig, keine Steuerzeichen) → `/agent-flow:train --bootstrap <pack-id> <urls…>`.
- **PR + Gate = Sicherheitsgrenze.** Neuer Pack erst nach `reviewer`-Check + **Mensch-Approve** im Knowledge Space.
- **Enabler in agent-flow.** Setzt [[train-bootstrap-new-pack]] voraus (`--bootstrap` legt neuen Pack ohne Vorgänger aus mitgegebenen Quellen an).

## Architektur-Auflagen (bindend, architekt-Review 2026-06-19)

Diese Auflagen sind Teil der Acceptance (AC10–AC15) und müssen umgesetzt werden:

- **A1 — Doktrin-Nachführung (Drift-Gate).** `dev-gui/.claude/CLAUDE.md` **und** `docs/architecture.md` MÜSSEN ergänzt werden, dass die bewusste `claude -p`-Ausnahme nun einen **zweiten, web-fähigen** zustandslosen Helfer umfasst (Tool `WebSearch`, kein Lock, kein API-Key). Ohne diese Anpassung = Doktrin-Drift = hartes reviewer-Gate (analog `fabric-intake-dialog.md` AC11).
- **A2 — Eigener `KnowledgeSourceService`.** Getrennte Boundary + getrennter Router; `AssistService` bleibt tool-/netz-los. Begründung verbindlich: andere Capability + anderes Schema + anderes Risikoprofil. **Kein** `kind`-Switch in `AssistService`.
- **A3 — Exklusive Tool-Allowlist.** `claude -p` wird mit `--allowedTools WebSearch` (und sonst **nichts**) gestartet — explizit KEINE Schreib-/Bash-/Edit-/Dateisystem-Tools. **`WebFetch` bewusst weggelassen** (architekt-Empfehlung gegen SSRF: die Suche liefert URLs, das Fetchen macht erst der train-Agent). Prüfbar: das Argument-Array enthält genau diese Allowlist.
- **A4 — Output ist nur Vorschlag.** dev-gui fetcht die gelieferten URLs **nie** selbst; sie fließen erst nach User-Auswahl + OK in `POST /api/command`. UI kennzeichnet sie als „Vorschlag, bitte prüfen" — nicht als verifizierte Autorität.
- **A5 — Backend-seitige URL-Validierung am Auslöse-Pfad.** Vor Komposition der `--bootstrap`-Zeile: jede bestätigte URL `^https?://`, keine Steuerzeichen/Leerzeichen, einzeilig — **backend-prüfbar**, nicht nur im Frontend.
- **A6 — Audit-First.** Ein Audit-Eintrag je akzeptiertem Helfer-Aufruf (`auditStore.record({ command: 'assist/knowledge-sources' })`), hinter `AccessGuard` — analog `assistRefineRouter`.
- **A7 — Timeout + fail-safe.** 60 s Timeout, höchstens **ein** Retry, danach manueller Quellen-Fallback (V4/AC5). Bei Timeout/Fehler `{ ok:false, reason:'claude-error' }`, kein Crash, kein Leak. Weiches Längenlimit auf `description`.

## Verhalten

### V1 — Einstieg im Train-Popup
Im Train-Popup ([[team-train-trigger]]) ein Button **„Neuen Knowledge Space anlegen"**. Klick öffnet den Anlage-Schritt (modaler Sub-View im selben Dialog; A11y wie der restliche Dialog).

### V2 — Beschreibung eingeben
Ein **Textfeld** (mehrzeilig) für die Beschreibung „was angelegt werden soll" (z.B. „Knowledge zu Rust für systemnahe Backend-Services, Fokus aktuelle stabile APIs"). Button **„Quellen suchen"**.

### V3 — Headless Quellen-Suche (Backend)
„Quellen suchen" ruft einen **neuen, eigenen** headless Helfer auf — `KnowledgeSourceService` (Muster `AssistService`, **eigene** Boundary, **kein** JobLock; nicht als `kind` in `AssistService`, A2): neuer Endpunkt `POST /api/assist/knowledge-sources` `{ description }`, hinter `AccessGuard`, mit Audit-Eintrag (A6). Der Helfer startet `claude -p` mit **exklusiv `--allowedTools WebSearch`** (kein `WebFetch`, kein anderes Tool — A3) und liefert strukturiertes JSON zurück:
```
{ suggestedPackId, suggestedType, sources: [ { title, url, why } ], notes }
```
- `description` geht via **stdin** an `claude` (nie als Prozess-Argument — security/R02); weiches Längenlimit (A7).
- Timeout 60 s + höchstens **ein** Retry, dann manueller Fallback; bei Timeout/Fehler `{ ok:false, reason:'claude-error' }`, secret-frei, kein Crash (A7).
- `suggestedPackId`/`suggestedType` sind Vorschläge (Owner kann überschreiben).

### V4 — Quellen anbieten & bestätigen (Frontend)
Während der Suche: Ladezustand (`aria-busy`). Ergebnis:
- **Liste der gefundenen offiziellen Quellen** unten, je Eintrag **Checkbox** (vorausgewählt) + Titel + URL + kurze Begründung („why").
- Editierbares **Pack-Name + Typ** (mit den Vorschlägen vorbefüllt).
- **OK/Bestätigen**-Button (aktiv, sobald Name gültig + ≥1 Quelle ausgewählt).
- **Manuelle Quelle hinzufügen** als Fallback (eine URL eintippen), falls die Suche zu wenig/nichts liefert.

### V5 — Pack-ID-Komposition & Kollisions-Check
Aus Name + Typ (+ Version) wird die kanonische Pack-ID gebildet (Resolver-Formen: Sprache `<name>`, Framework `<name>@<major>`, Build `build/<name>`, Migration `migration/<name>[@<major>]`). Existiert der Name bereits in der Knowledge-Liste (`GET /api/team`) → Hinweis „existiert bereits — über ‚Vorhandenes trainieren' aktualisieren"; OK deaktiviert.

### V6 — Auslösen
OK sendet **einen** einzeiligen Befehl `/agent-flow:train --bootstrap <pack-id> <url1> <url2> …` (nur die **bestätigten** Quellen) an `POST /api/command`. Doppel-Feuer-Schutz; Status-Rückmeldung (gestartet/abgelehnt).

### V7 — Ergebnis
Der Lauf liefert einen **PR** (über `train --bootstrap`). Nach **Approve** erscheint der neue Knowledge Space in `/api/team`. Das Popup verweist auf PR/Verbesserungs-Board, ohne dort etwas zu ändern.

## Acceptance-Kriterien

- **AC1** — Train-Popup hat einen Button „Neuen Knowledge Space anlegen"; Klick öffnet den Anlage-Schritt (A11y-konform). *(V1)*
- **AC2** — Anlage-Schritt bietet ein mehrzeiliges Beschreibungsfeld + Button „Quellen suchen". *(V2)*
- **AC3** — „Quellen suchen" ruft `POST /api/assist/knowledge-sources {description}` (headless, kein JobLock, `description` via stdin) und erhält `{ suggestedPackId, suggestedType, sources[], notes }`. *(V3)*
- **AC4** — Die gefundenen Quellen werden als Checkbox-Liste (Titel/URL/Begründung, vorausgewählt) angezeigt; Name+Typ editierbar (vorbefüllt); Ladezustand mit `aria-busy`; Timeout/Fehler → klare, secret-freie Meldung. *(V3, V4)*
- **AC5** — Manuelles Hinzufügen einer Quelle ist als Fallback möglich. *(V4)*
- **AC6** — Pack-ID wird kanonisch aus Name+Typ(+Version) gebildet; existiert der Name bereits → OK deaktiviert + Hinweis auf Trainieren. *(V5)*
- **AC7** — OK sendet genau einen einzeiligen `/agent-flow:train --bootstrap <pack-id> <bestätigte-urls…>` an `POST /api/command`; nur `/agent-flow:train`-Präfix; keine Steuerzeichen; URLs `http(s)://`. *(V6)*
- **AC8** — OK ist erst aktiv bei gültigem Namen + ≥1 ausgewählter Quelle; Doppel-Feuer-Schutz; Status-Rückmeldung. *(V4, V6)*
- **AC9** — Security-Floor: `description` nie als Prozess-Argument (stdin, R02), Argumente als Array (R03), kein Secret in Response/Log, kein `dangerouslySetInnerHTML`; nur `/api/team`, `/api/session`, `/api/command`, `/api/assist/knowledge-sources`. *(alle)*
- **AC10** — `CLAUDE.md` + `docs/architecture.md` sind um den zweiten, web-fähigen headless Helfer ergänzt (Tool `WebSearch`, kein Lock, kein API-Key); ohne diese Nachführung = Drift-Gate. *(A1)*
- **AC11** — Der Helfer ist ein **eigener** `KnowledgeSourceService` mit eigenem Router; `AssistService` bleibt unverändert tool-/netz-los (kein `kind`-Switch). *(A2)*
- **AC12** — `claude -p` wird mit exklusiv `--allowedTools WebSearch` gestartet (kein `WebFetch`/Schreib-/Bash-/Edit-/FS-Tool); prüfbar am Argument-Array. *(A3)*
- **AC13** — dev-gui fetcht die gelieferten URLs nie selbst; sie fließen erst nach Auswahl + OK in den Befehl; UI kennzeichnet sie als „Vorschlag, bitte prüfen". *(A4)*
- **AC14** — URL-Validierung (`^https?://`, keine Steuerzeichen/Leerzeichen, einzeilig) erfolgt **backend-seitig** vor der Befehls-Komposition, nicht nur im Frontend. *(A5)*
- **AC15** — Je akzeptiertem Helfer-Aufruf genau ein Audit-Eintrag (`assist/knowledge-sources`) hinter `AccessGuard`; Timeout 60 s + max. 1 Retry, fail-safe. *(A6, A7)*

## Verträge

- **`POST /api/assist/knowledge-sources`** (neu, headless, kein JobLock, hinter `AccessGuard`, Audit-Eintrag) — Request `{ description: string }`; Response `{ ok: true, suggestedPackId, suggestedType, sources: [{title,url,why}], notes }` oder `{ ok: false, reason, message }`. **Eigener** `KnowledgeSourceService` (Muster `AssistService`), `claude -p --allowedTools WebSearch` (kein WebFetch), Eingabe via stdin.
- **`GET /api/team`** (bestehend) — Knowledge-Liste für den Kollisions-Check.
- **`POST /api/command`** (bestehend) — `{ command: "/agent-flow:train --bootstrap <pack-id> <urls…>" }`.
- **Cross-Repo:** Verarbeitung durch den Train-Agenten gemäß [[train-bootstrap-new-pack]] (agent-flow).

## Edge-Cases & Fehlerverhalten

- **Suche liefert nichts/Fehler/Timeout** → Hinweis + manuelles Hinzufügen (AC5) bleibt möglich.
- **Name existiert** → OK deaktiviert (AC6).
- **Keine Quelle ausgewählt** → OK deaktiviert (AC8).
- **claude -p nicht verfügbar** → `{ ok:false, reason:'claude-error' }`, secret-freie Meldung, kein Crash.
- **Session busy / `409`** beim Auslösen → Hinweis „Session belegt", kein Verlust.

## NFRs

- **Headless-Boundary sauber getrennt** (kein JobLock, kein PTY); PTY-/Flow-Pfad unberührt (Doktrin).
- **Web-Zugriff nur im Anlage-Helfer**, eng begrenzt + auditiert; kein API-Key (Abo-OAuth), analog `AssistService`.
- **A11y/Security** konsistent mit [[team-train-trigger]] und [[fabric-intake-dialog]].

## Nicht-Ziele

- **Eigener mehrzeiliger Seed-Inhalt** als Pack-Inhalt (nicht gewählt; bräuchte Nebenkanal).
- **Auto-Merge** neuer Packs — bleibt PR + Approve.
- **Bootstrap-Logik selbst** — agent-flow ([[train-bootstrap-new-pack]]).

## Offene Fragen

> Alle drei Fragen durch das architekt-Review 2026-06-19 geklärt (siehe „Architektur-Auflagen (bindend)").

1. **Headless Web-Oberfläche** — geklärt: `APPROVE-WITH-CONDITIONS`; Tool-Allowlist **`WebSearch`** exklusiv (kein `WebFetch`, SSRF-Reduktion), Doktrin-Nachführung Pflicht (A1, A3).
2. **Eigener Service vs. `kind`** — geklärt: **eigener** `KnowledgeSourceService` (A2).
3. **Timeout/Retry** — geklärt: 60 s + max. 1 Retry, fail-safe + manueller Fallback (A7).

## Abhängigkeiten

- **dev-gui:** `client/src/TeamView.jsx` (Train-Popup: Button + Anlage-Schritt + Quellen-Liste), neuer `src/KnowledgeSourceService.js` + Router (`POST /api/assist/knowledge-sources`, Muster `src/AssistService.js`/`assistRefineRouter.js`), `src/CommandService.js` (Allowlist — `train` erlaubt).
- **Specs:** [[team-train-trigger]] (Basis-Dialog), [[fabric-intake-dialog]] (Headless-Helfer-Muster).
- **Cross-Repo (Enabler):** agent-flow [[train-bootstrap-new-pack]].
