---
id: token-usage-meter
title: Proaktive Token-Verbrauchsmessung aus Claude-Session-Transcripts
status: active
area: nachtwaechter
version: 1
---

# Spec: Token-Verbrauchsmessung aus Session-Transcripts  (`token-usage-meter`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Für den **proaktiven** Nacht-Budget-Schutz ([[night-budget-guard]]) muss der laufende Token-Verbrauch **gemessen** werden, **bevor** das harte Session-Limit erreicht ist. Claude Code schreibt je Session ein Transcript als JSON-Lines-Datei unter `~/.claude/projects/<projekt-hash>/<session-id>.jsonl` (im Container-Home des dev-gui-Prozesses). Jede Assistenten-Antwort trägt eine `usage`-Struktur mit **Output-Tokens**. Diese Spec führt einen schmalen, **read-only** `TokenUsageMeter` ein, der diese Transcripts liest, die **Output-Tokens** innerhalb eines vom Aufrufer vorgegebenen Zeitfensters summiert und als Messwert liefert. [[night-budget-guard]] vergleicht diesen Messwert gegen das konfigurierte Nacht-Budget.

Bewusst **nur Messung, keine Policy**: der Meter kennt weder das Budget noch die Schwelle noch die Pause — er liefert ausschliesslich den Verbrauchs-Ist-Wert. Die Budget-/Schwellen-/Pause-Entscheidung liegt vollständig in [[night-budget-guard]] (Trennung von Messung und Politik → einfache, deterministische Unit-Tests ohne Zeit-/Settings-Kopplung).

## Annahmen (konservativ, da nicht-interaktiv geklärt)
- **A1 — Transcript-Pfad.** Basis ist `${HOME}/.claude/projects/` (Container-Home). Ist `HOME` nicht gesetzt oder das Verzeichnis nicht vorhanden/lesbar → Messwert `0` (kein Fehler, degradiert; der Guard behandelt „keine Messung möglich" konservativ, siehe [[night-budget-guard]]). Der Pfad ist **home-confined** (kein Freitext-/Traversal-Pfad von aussen).
- **A2 — Output-Token-Feld.** Gezählt werden die **Output-Tokens** je Assistenten-Event: das Feld `message.usage.output_tokens` (JSON-Lines). Fehlt `usage`/`output_tokens` in einer Zeile, trägt diese Zeile `0` bei (robust gegen Format-Varianten). **Cache-/Input-Tokens werden bewusst NICHT** mitgezählt (die Anforderung nennt ausdrücklich Output-Tokens) — dies ist eine dokumentierte, konservative Wahl und Nicht-Ziel jeder Erweiterung dieser Story.
- **A3 — Zeitfenster.** Der Aufrufer übergibt `sinceMs` (ms epoch). Gezählt werden nur Events mit einem Zeitstempel **≥ `sinceMs`** (Event-Feld `timestamp`, ISO-8601). Events ohne parsebaren Zeitstempel werden **nicht** gezählt (defensiv: lieber untermessen als eine alte, fensterfremde Zahl mitzuschleppen). Ohne `sinceMs` (`null`/undefined) werden **alle** Events gezählt (Gesamtverbrauch — der Guard entscheidet über das Fenster).
- **A4 — Konto-weit, nicht projekt-scoped.** Das Session-Limit gilt konto-weit ([[taktgeber-nachtwaechter]] AC13). Der Meter summiert daher über **alle** Projekt-Unterordner unter `~/.claude/projects/`, nicht nur den gerade gedrainten (mehrere parallele headless-`claude -p`-Prozesse teilen ein Abo-Token).

## Verhalten
1. **`getUsage({ sinceMs }) → { outputTokens, filesScanned, entriesCounted }`** — liest rekursiv alle `*.jsonl` unter `${HOME}/.claude/projects/`, parst jede Zeile als JSON, summiert `message.usage.output_tokens` über alle Assistenten-Events mit Zeitstempel ≥ `sinceMs` (A3). Rückgabe: der summierte Output-Token-Wert plus schmale Diagnose-Zähler (Anzahl gescannter Dateien / gezählter Einträge — nur Zahlen, keine Inhalte).
2. **Defensiv gegen unlesbare/korrupte Daten.** Eine nicht als JSON parsebare Zeile wird **übersprungen** (kein Crash, Zeile trägt `0` bei). Eine unlesbare Datei wird übersprungen. Fehlendes Basis-Verzeichnis → `{ outputTokens: 0, filesScanned: 0, entriesCounted: 0 }`.
3. **Read-only, keine Seiteneffekte.** Der Meter schreibt **nie** in die Transcripts oder sonst wohin; er hält keinen State über einen Aufruf hinaus (reiner Lese-Scan je Aufruf) — außer einem optionalen, betreiber-nahen Kurz-Cache (Nicht-Ziel dieser Story).
4. **Größen-/Performance-Schutz.** Sehr große Transcript-Dateien werden **zeilenweise/streamend** verarbeitet (kein Voll-Laden mehrerer MB in einen String, wo vermeidbar); der Scan ist auf `${HOME}/.claude/projects/` begrenzt (keine unbegrenzte FS-Traversierung).

## Acceptance-Kriterien

- **AC1** — `TokenUsageMeter.getUsage({ sinceMs })` liest rekursiv `*.jsonl` unter `${HOME}/.claude/projects/`, summiert `message.usage.output_tokens` über alle Zeilen mit `timestamp ≥ sinceMs` und liefert `{ outputTokens:<int>, filesScanned:<int>, entriesCounted:<int> }`. `HOME`-basierter Pfad (injizierbar für Tests), **home-confined**, kein Freitext-/Traversal-Pfad. *(1, A1, A2, A3)*
- **AC2** — `sinceMs` filtert: Events mit `timestamp < sinceMs` oder **ohne** parsebaren Zeitstempel zählen **nicht**; `sinceMs = null`/undefined zählt **alle** Events. Nur `output_tokens` wird summiert (Input/Cache **nicht**, A2). *(1, A2, A3)*
- **AC3** — Konto-weit: der Scan aggregiert über **alle** Projekt-Unterordner unter `~/.claude/projects/` (nicht nur ein einzelnes Projekt). *(A4)*
- **AC4** — Robustheit: eine nicht-JSON-parsebare Zeile, eine Zeile ohne `usage`/`output_tokens`, eine unlesbare Datei oder ein fehlendes Basis-Verzeichnis führen **nie** zu einem Crash — die betroffene Einheit trägt `0` bei; fehlendes Verzeichnis → `{ outputTokens:0, filesScanned:0, entriesCounted:0 }`. *(2, A1)*
- **AC5** — Read-only + größenbegrenzt: der Meter schreibt nirgends, verarbeitet `*.jsonl` zeilenweise (kein Voll-String-Laden großer Dateien wo vermeidbar) und traversiert ausschließlich unterhalb `${HOME}/.claude/projects/`. **Keine** Secrets/Prompt-Inhalte/absoluten Host-Pfade werden zurückgegeben oder geloggt — nur Zahlen. *(3,4)*
- **AC6** — Gate = Unit-Tests gegen ein **temporäres, injiziertes Basis-Verzeichnis** mit synthetischen `*.jsonl`-Fixtures (kein echtes `~/.claude`). Der Basis-Pfad ist über den Konstruktor/Parameter injizierbar. *(alle)*

## Verträge

### `TokenUsageMeter` (neu, `src/TokenUsageMeter.js`)
- Konstruktor injizierbar: `baseDir` (Default `join(os.homedir(), '.claude', 'projects')`), optional `fsImpl`/Lese-Primitive für Tests.
- `getUsage({ sinceMs?: number|null }) → Promise<{ outputTokens: number, filesScanned: number, entriesCounted: number }>`
- Rein lesend; keine öffentlichen HTTP-Endpunkte in dieser Story (der Guard konsumiert die Klasse direkt, Composition-Root-Wiring liegt in [[night-budget-guard]]).

### Transcript-Zeilenform (angenommen, A2)
- JSON-Lines; relevante Felder je Zeile: `type` (Assistenten-Event), `timestamp` (ISO-8601), `message.usage.output_tokens` (int). Fehlende Felder → `0`-Beitrag (robust, kein Schema-Zwang).

## Edge-Cases & Fehlerverhalten
- **`HOME` nicht gesetzt / Verzeichnis fehlt** → `{ outputTokens:0, … }` (kein Fehler).
- **Leere Datei / nur Whitespace-Zeilen** → `0`-Beitrag.
- **Zeile mit `usage` aber `output_tokens` fehlt/kein Int** → `0`-Beitrag (kein NaN in der Summe).
- **Sehr viele/sehr große Dateien** → zeilenweise Verarbeitung, Scan bleibt auf das Basis-Verzeichnis begrenzt (kein Symlink-Ausbruch nach aussen — defensiv, keine Traversierung oberhalb `baseDir`).
- **Zeitstempel in fremdem Format** → nicht parsebar ⇒ Event zählt nicht (A3).

## NFRs
- **Sicherheit (Floor):** Prompt-/Antwort-Inhalte der Transcripts werden **nie** ausgelesen/zurückgegeben/geloggt — ausschließlich die numerischen `usage`-Felder + Zeitstempel. Home-confined Pfad, keine absoluten Host-Pfade in Rückgabe/Log. Kein Schreibzugriff.
- **Robustheit:** vollständig degradierend — jeder Lese-/Parse-Fehler senkt höchstens den Messwert, crasht nie (der Guard behandelt einen `0`/untermessenen Wert konservativ).
- **Performance:** je Aufruf ein begrenzter FS-Scan; für den Nacht-Einsatz (Poll-Intervall Minuten) ausreichend. Ein optionaler Kurz-Cache ist Nicht-Ziel.

## Nicht-Ziele
- **Keine** Budget-/Schwellen-/Pause-Logik (liegt in [[night-budget-guard]]).
- **Keine** Zählung von Input-/Cache-Tokens (nur Output, A2).
- **Kein** öffentlicher HTTP-Endpunkt, **keine** persistente Verbrauchs-Historie, **kein** Reset-Zeitpunkt-Tracking (der Reset kommt reaktiv aus [[headless-budget-limit-detection]] bzw. wird vom Guard bestimmt).
- **Keine** Anthropic-API-Nutzung (rein lokale Datei-Messung).

## Abhängigkeiten
- [[night-budget-guard]] (einziger Konsument der Messung) · [[taktgeber-nachtwaechter]] (Konto-weite Limit-Sicht, AC13) · [[headless-parallel-drain]] (mehrere parallele `claude -p`-Sessions teilen ein Abo-Token → konto-weite Aggregation, A4).
