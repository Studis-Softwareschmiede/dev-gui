---
id: obsidian-project-intake
title: „Aus Obsidian-Notizen" — dritte Option im Neues-Projekt-Flow, Trigger /agent-flow:from-notes
status: active
area: obsidian
version: 1
spec_format: use-case-2.0
---

# Spec: „Aus Obsidian-Notizen" — Projekt-Anlage aus Notizen (`obsidian-project-intake`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate.

## Zweck
Der „Neues Projekt anlegen"-Flow bekommt neben den zwei bestehenden Wegen — **komplett neu** ([[github-repo-create]]) und **aus GitHub klonen** ([[github-repo-clone]]) — eine **dritte Option „Aus Obsidian-Notizen"**. Der Nutzer wählt einen **Projekt-Unterordner** aus dem konfigurierten Vault (Liste unter `<vault>/Projekte`, geliefert von [[obsidian-vault-config]]) und **löst damit die Fabrik-Pipeline `/agent-flow:from-notes <ordner>` aus** — über den **bestehenden** Command-Kanal (`POST /api/command`), exakt analog zu den bereits vorhandenen Flow-auslösenden Triggern (`/flow`, `/adopt`, `/preview`; siehe [[flow-trigger]] · [[reconcile-trigger]]). Läuft die Pipeline in einem Rutsch durch, landet das Ergebnis wie gewohnt im Board/`docs/` und ist **live im Terminal** sichtbar. Etwaige Rückfragen der Pipeline werden in dieser Kern-Spec **interaktiv im Terminal-Handoff** beantwortet (wie die `requirement`-Rückfragen in [[fabric-intake-dialog]]); die **strukturierte Fragenkatalog-Anzeige in der GUI** ist die eigene, dependency-gatete Folge-Capability [[obsidian-question-catalog]].

> **Scope-Grenze (SR3, Cross-Repo):** Die **Pipeline-Logik** (Notiz → Konzept → Spezifikation → Story, 3 Stufen, Widerspruchserkennung) lebt **ausschließlich** in agent-flow (Skill `/agent-flow:from-notes`, PR #217 · `docs/architecture/obsidian-ingest-subsystem.md`). dev-gui **löst nur aus** und reicht den Ordner-Pfad als sanitisiertes Argument in den bestehenden, allowlist-geschützten Command-Kanal. Diese Spec entwirft die Fabrik-Seite **nicht** neu (gegebene Schnittstelle, lose gekoppelt).

## Verhalten
1. Der „Neues Projekt"-Einstieg (heute zwei Optionen: neu / klonen) zeigt eine **dritte Option „Aus Obsidian-Notizen"**. Ist **kein** Vault konfiguriert ([[obsidian-vault-config]] `configured: false`), ist die Option sichtbar, aber **deaktiviert** (disabled-Attribut **+** Text-Hinweis „Zuerst Obsidian-Vault in den Einstellungen setzen", nie nur Farbe) mit Verweis auf die Einstellungen.
2. Wählt der Nutzer „Aus Obsidian-Notizen", zeigt der Flow eine **Auswahl der Projekt-Unterordner** aus `GET /api/settings/obsidian-vault/projects` ([[obsidian-vault-config]] AC5) — je Eintrag `name` (sichtbar) + `path` (an die Pipeline weiterzureichen). Leere Liste → klarer Hinweis „keine Projekte unter <vault>/Projekte gefunden". Ladefehler → sichtbare Fehleranzeige, **kein** Crash.
3. **Auslösen.** Der Nutzer wählt genau **einen** Ordner und bestätigt. Das Frontend komponiert die **Einzeilen**-Befehlszeile `/agent-flow:from-notes <path>` (der `path` aus der Liste, **kein** Freitext) und POSTet sie **genau einmal** über den bestehenden `POST /api/command` (projektgebundene Session-Konvention wie [[reconcile-trigger]]/[[flow-trigger]]).
4. **Allowlist.** `/agent-flow:from-notes` ist **neu** in der Backend-Allowlist (`DEFAULT_ALLOWED_COMMANDS`, `src/CommandService.js`) — analog zur Aufnahme von `/agent-flow:reconcile` ([[reconcile-trigger]]) und `/agent-flow:new-project` ([[fabric-intake-dialog]] AC3). Ohne diesen Eintrag würde jeder Klick mit `400` (Allowlist-Reject) abgewiesen. Die bestehende Sanitisierung ([[flow-trigger]] AC2) bleibt **unverändert** die Enforcement-Grenze; der Ordner-Pfad passiert sie als **eine** Zeile ohne Steuerzeichen.
5. **Concurrency-Sperre.** Läuft bereits ein Job (`GET /api/session` → `state:"busy"` **oder** Antwort `409`), ist die „Auslösen"-Aktion **deaktiviert** (disabled-Attribut **+** Text-Label/Lock-Hinweis, nie Farbe allein); ein Klick löst dann **keinen** POST aus.
6. **Erfolg (202).** Nach erfolgreichem Auslösen wechselt die Ansicht in den Terminal-/Arbeiten-Bereich (`onNavigate('factory')`), damit der Lauf **live** sichtbar ist — konsistent zum Flow-/Reconcile-/Intake-Muster ([[reconcile-trigger]] AC5 · [[fabric-intake-dialog]] AC4). Rückfragen der Pipeline erscheinen **im Terminal** und werden dort beantwortet (Terminal-Handoff); die richere GUI-Fragenkatalog-Anzeige ist [[obsidian-question-catalog]].
7. **Fehler.** `400` (Allowlist/Sanitisierung), `409` (Lock), `500`/Netzwerkfehler → sichtbare Fehler-/Status-Anzeige mit Reset-Möglichkeit; **kein** `onNavigate`, kein Crash.

## Acceptance-Kriterien
- **AC1** — Der „Neues Projekt"-Einstieg zeigt **drei** Optionen: die zwei bestehenden (neu / aus GitHub klonen) **unverändert** + neu **„Aus Obsidian-Notizen"**. Ist kein Vault konfiguriert, ist die neue Option **deaktiviert** (disabled **+** Text-Hinweis auf die Einstellungen, nicht nur Farbe); Touch-Target ≥ 44 px. *(1)*
- **AC2** — Auswahl „Aus Obsidian-Notizen" lädt die Projekt-Unterordner über `GET /api/settings/obsidian-vault/projects` und zeigt sie als **auswählbare Liste** (`name` sichtbar). Leere Liste → klarer Hinweis (kein Auslöser aktiv); Ladefehler → sichtbare Fehleranzeige, kein Crash. *(2)*
- **AC3** — Bei ausgewähltem Ordner POSTet „Auslösen" **genau einmal** `{ command: '/agent-flow:from-notes <path>', projectPath? }` an `POST /api/command`, wobei `<path>` **ausschließlich** der `path` aus der Liste ist (kein Freitext) und zu **einer** Zeile ohne Steuerzeichen kollabiert ist. Ohne Auswahl ist „Auslösen" deaktiviert. *(3)*
- **AC4** — `/agent-flow:from-notes` ist in der **Backend-Allowlist** (`DEFAULT_ALLOWED_COMMANDS`) ergänzt; ein Trigger mit diesem Präfix wird akzeptiert (`202`), alle bisher gelisteten Präfixe bleiben gültig (Backwards-Compat). Die Sanitisierung aus [[flow-trigger]] AC2 ist **unverändert**. *(4)*
- **AC5** — Bei aktivem Job (`GET /api/session` → `state:"busy"`) ist „Auslösen" **deaktiviert** (disabled-Attribut **+** zugängliches Label/Lock-Hinweis per Text, nicht nur Farbe); ein Klick löst **keinen** POST aus. *(5)*
- **AC6** — Antwort `202` → `onNavigate('factory')` (Lauf live im Terminal); kein stehengebliebenes „gestartet"-Element im Projekt-Anlage-Flow. *(6)*
- **AC7** — Antwort `409` → sichtbare Fehler-/Status-Anzeige (Job läuft bereits), **kein** `onNavigate`, kein Crash. Netzwerkfehler/`400`/`500` → sichtbare Fehler-Anzeige mit Reset, **kein** `onNavigate`. *(7)*

## Verträge
- **`POST /api/command`** (bestehend, [[flow-trigger]]) — **unverändert**; **Allowlist erweitert** um `/agent-flow:from-notes`. `{ command: "/agent-flow:from-notes <path>", projectPath?: string }` → `202 { commandId, status }` | `400` (Allowlist/Sanitisierung) | `409` (Lock) | `500`. `<path>` ist der vault-confined Ordner-Pfad aus [[obsidian-vault-config]] AC5 (kein Freitext).
- **`GET /api/settings/obsidian-vault/projects`** ([[obsidian-vault-config]] AC5) — Quelle der auswählbaren Ordner-Liste.
- **`GET /api/session`** → `{ state: "ready"|"busy", … }` — Quelle des Busy-/Lock-Zustands (Polling-Muster wie `TriggerPanel`/`FactoryWorkspace`).
- **Cross-Repo (SR3):** Die gesamte from-notes-**Logik** (3 Stufen, Widerspruchs-Fragenkatalog) lebt in **agent-flow** (`docs/architecture/obsidian-ingest-subsystem.md`, PR #217); der Allowlist-Eintrag ist dev-gui-lokale Backend-Konfiguration. Die UI ist davon **entkoppelt** baubar/testbar (mockbarer `fetchFn`); kein dev-gui-Test hängt von einer realen agent-flow-Antwort ab.

## Edge-Cases & Fehlerverhalten
- Kein Vault konfiguriert → Option sichtbar aber deaktiviert (AC1); `projects`-Fetch wird gar nicht erst ausgelöst.
- Projekt-Liste leer → klarer Hinweis, „Auslösen" bleibt inaktiv.
- Klick bei bereits busy-er Session → no-op (kein POST), AC5.
- `409` trotz freiem UI-Zustand (Race) → Fehleranzeige, kein Navigate, AC7.
- Doppelklick auf „Auslösen" während `starting` → kein zweiter POST (Button im `starting`-Zustand gesperrt).
- Ordner-`path` mit ungewöhnlichen Zeichen → wird von der bestehenden Sanitisierung behandelt; da `path` aus der server-confined Liste stammt (nicht Freitext), keine neue Trust-Boundary.
- Fehlt `projectSlug`/`activeRepo` → `projectPath` wird weggelassen (Backwards-Compat zum `/api/command`-Vertrag; wie [[reconcile-trigger]]).

## NFRs
- **Sicherheit (Floor):** **kein** neuer Backend-Endpunkt, **keine** neue Trust-Boundary — der Befehl durchläuft die bestehende, unveränderte Sanitisierung ([[flow-trigger]] AC2) und ist server-seitig allowlistet (AC4). Der Ordner-Pfad kommt aus der server-confined Vault-Liste ([[obsidian-vault-config]] AC3/AC5), nicht aus Freitext. Kein `dangerouslySetInnerHTML`, keine Secrets im Bundle.
- **A11y (WCAG 2.1 AA):** Optionen/Liste beschriftet, Auswahl per Tastatur, Button-Sperre via disabled-Attribut **und** Text-Label (nie Farbe allein), sichtbarer Fokusring, Touch-Targets ≥ 44 px.

## Nicht-Ziele
- Die from-notes-**Pipeline-Logik** (3 Stufen, Konzept/Spec/Story-Erzeugung, Widerspruchserkennung) — liegt vollständig in agent-flow (`obsidian-ingest-subsystem.md`).
- Die **strukturierte GUI-Fragenkatalog-Anzeige** (Anzeige von `stage/id/frage/quelle/optionen`, gesammelte Antwort-Rückgabe, Interrupt/Resume) — bewusst **eigene** Folge-Spec [[obsidian-question-catalog]]. In dieser Kern-Spec laufen Rückfragen über den **Terminal-Handoff**.
- Die **Vault-Pfad-Konfiguration + Projekt-Auflistung** selbst — [[obsidian-vault-config]].
- Änderungen am `/api/command`-Endpunkt, an der Sanitisierung oder am generischen TriggerPanel-Befehlskatalog von [[flow-trigger]] (nur die Backend-**Allowlist** wird ergänzt, Präzedenz [[reconcile-trigger]]/[[fabric-intake-dialog]] AC3).

## Abhängigkeiten
- [[obsidian-vault-config]] (Vault-Pfad + `GET …/obsidian-vault/projects` — Auswahlgrundlage). **Depends-on.**
- [[flow-trigger]] (POST `/api/command`, Allowlist, Sanitisierung, Session-Lock — unverändert genutzt).
- [[reconcile-trigger]] / [[fabric-intake-dialog]] (Trigger-/Busy-Guard-/Navigate-Muster, das hier gespiegelt wird; Allowlist-Erweiterungs-Präzedenz).
- [[github-repo-create]] / [[github-repo-clone]] (die zwei bestehenden „Neues Projekt"-Wege, neben die die dritte Option tritt).
- **agent-flow** `docs/architecture/obsidian-ingest-subsystem.md` (PR #217, Cross-Repo-Vertrag, SR3) — liefert den Befehl `/agent-flow:from-notes <ordner>`.

## Offene Annahmen (mangels Rückfrage-Möglichkeit als Subagent gesetzt — vom Owner bestätigbar)
- **A1 (Argument-Form):** `/agent-flow:from-notes` erwartet **einen** Ordner-Pfad als Argument (der vom Vault-Listing gelieferte `path`). Ob agent-flow einen **absoluten** Pfad, einen **vault-relativen** Pfad oder einen **Projekt-Namen** erwartet, ist in PR #217 noch nicht verbindlich; `path` wird so geliefert, dass beide Seiten dieselbe Basis meinen (Confinement-sicher). Owner/architekt fixieren die exakte Argument-Form beim Merge von #217.
- **A2 (Ausführungsmodell):** Der Trigger läuft — wie vom Auftrag vorgegeben — über die **interaktive PTY-Session** (`POST /api/command`, analog `/adopt`/`/preview`). Falls der Owner (analog ADR-017 manueller Drain) einen **headless** Lauf bevorzugt, verschiebt sich das Trigger-Detail; die dritte Option + Ordner-Auswahl bleiben unverändert. Der strukturierte Fragenkatalog ([[obsidian-question-catalog]]) impliziert ohnehin einen headless/strukturierten Rückkanal — dort wird das Modell final entschieden.
