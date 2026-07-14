---
id: rtk-output-shaping-pilot
title: RTK-Ausgabe-Diät — Mess-Pilot im Konsum-Repo (dev-gui)
status: active
area: retro-lernen
version: 1
---

# Spec: RTK-Ausgabe-Diät — Mess-Pilot im Konsum-Repo  (`rtk-output-shaping-pilot`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (führt den Pilot aus + baut den Bericht), `tester` (prüft die Acceptance-Kriterien), `reviewer` (prüft den Diff/Bericht dagegen — hartes Drift-Gate).

## Zweck
Der agent-flow-Spike **`output-token-shaping`** (Story S-065, ADR `docs/architecture/output-token-shaping.md` im agent-flow-Repo) hat die Trennlinie (welche Bash-Ausgaben gefiltert werden dürfen) und eine **Vorab-Empfehlung** geliefert — **„C sofort (Prompt-Ebene) + A mittelfristig (Eigenbau, in Knowledge Packs verankert), B (RTK-Binary) nur bedingt"**. Diese Empfehlung ist ausdrücklich **messungs-vorbehaltlich**: Die tatsächliche Token-Ersparnis von RTK blieb offen, weil agent-flow selbst ein `md`-Repo mit No-Op-`build`/`test` ist und keine echten Test-Runner-/Build-Ausgaben zum Eindampfen hat.

dev-gui ist das passende **echte Konsum-Repo**: hier laufen reale `/flow`-Läufe mit echten JS-Test-/Build-/Lint-Ausgaben, Git-Diffs und Docker-Kommandos — genau die Befehle, auf die RTK zielt. Ziel dieses Piloten: die offene Mess-Lücke aus dem ADR schließen und die Vorab-Empfehlung **empirisch bestätigen oder widerlegen** — mit der harten Nebenbedingung, dass die Fabrik-Gates (`reviewer`/`tester`) durch die Ausgabe-Kürzung **nicht** getäuscht werden.

## Randbedingungen (bindend, aus dem agent-flow-ADR)
- **Trennlinie ist maßgeblich:** RTK wird **nur** auf die im ADR definierte Allowlist angewandt (Klasse A „gefahrlos filterbar" + Klasse B „nur signal-erhaltend"). Klasse C („nie filtern" — alles, was einen wörtlichen Klassifikations-Beleg speist, `coder/R02`/`reviewer/R01`) bleibt **roh**.
- **Kein Maskieren echter Fehlschläge:** Ein durch Kürzung verdeckter roter Test/Review-Befund ist ein **Abbruch-Kriterium**, kein akzeptierter Nebeneffekt.
- **Supply-Chain:** RTK ist ein Fremd-Binary im PreToolUse-Hot-Path. Die im ADR offen gelassenen Prüfpunkte (Maintainer-Reputation, Update-Cadence, Release-Signierung) werden vor Aktivierung dokumentiert-geprüft.

## Acceptance-Kriterien

- **AC1 — Setup dokumentiert & reproduzierbar.** RTK ist installiert (Installationsweg + exakte Version festgehalten); der PreToolUse-Hook ist **auf die ADR-Allowlist beschränkt** (Klasse A + B signal-erhaltend, Klasse C ausgeschlossen); **Telemetrie verifiziert AUS** (Default bestätigt, kein Opt-in gesetzt). Die Supply-Chain-Vorprüfung aus dem ADR ist als kurze Notiz abgehakt (oder als Rest-Risiko benannt). Alles reproduzierbar in `docs/` festgehalten.
- **AC2 — Baseline-Messung (ohne RTK).** N ≥ 3 vergleichbare `/flow`-Läufe in dev-gui **ohne** RTK-Hook; je Lauf `tok_total` (und je Dispatch die Token) aus dem Metrik-Ledger (`.claude/metrics/items.jsonl` / `dispatches.jsonl`) erfasst. Die Auswahl der Referenz-Storys ist dokumentiert (vergleichbare Größenklasse, damit der Vor/Nach-Vergleich fair ist).
- **AC3 — RTK-Messung (mit RTK).** Dieselbe Art von N ≥ 3 `/flow`-Läufen **mit** aktivem RTK-Hook; `tok_total` je Lauf + `rtk gain` je Befehlsklasse erfasst. Ergebnis: gemessene Ersparnis gesamt und je Klasse (A/B), gegenübergestellt der Baseline aus AC2.
- **AC4 — Pflicht-Gegenprobe (Fidelity).** Die **Gate-Ergebnisse** (`reviewer`/`tester` PASS/FAIL) der RTK-Läufe sind mit den Baseline-Läufen **konsistent** — kein Gate kippt allein wegen gekürzter Ausgabe, kein maskierter Fehlschlag. Tritt eine Abweichung auf, wird der auslösende Befehl aus Klasse B nach Klasse C verschoben (roh) und der Fall im Bericht dokumentiert; RTK bleibt nur aktiv, wenn die Gate-Treue gewahrt ist.
- **AC5 — Bericht + Rückkopplung ins ADR.** Ein Ergebnis-Bericht unter `docs/` (gemessene Ersparnis, Fidelity-Urteil, Supply-Chain-Fazit) mit einer klaren Aussage, ob die agent-flow-Vorab-Empfehlung **bestätigt oder revidiert** wird (insb.: wird **B/RTK** übernommen, verworfen oder durch **A/Eigenbau** ersetzt?). Der Bericht benennt die konkrete Rückmeldung an das agent-flow-ADR `output-token-shaping` (welche Zeile/Empfehlung dort mit den Messwerten zu aktualisieren ist) — die tatsächliche ADR-Aktualisierung ist ein Folge-Schritt im agent-flow-Repo (Cross-Repo-Markierung, nicht Teil dieses dev-gui-PRs).

## Verträge
- **Messgröße:** `tok_total` je `/flow`-Item aus `items.jsonl` (Source of Truth), ergänzt um `rtk gain`-Ausgabe als Quervalidierung. Keine geschätzten Zahlen — nur gemessene.
- **Vergleichbarkeit:** Baseline- und RTK-Läufe nutzen Storys ähnlicher Größenklasse (`size_est`) und Sprache (`js`), damit die Differenz auf RTK zurückführbar ist und nicht auf Story-Streuung.
- **Reversibilität:** Der RTK-Hook wird nach dem Piloten wieder entfernt, sofern AC5 nicht die Übernahme empfiehlt (kein dauerhafter Produktivpfad ohne positive Empfehlung).

## Edge-Cases & Fehlerverhalten
- **E1 — RTK-Parse-Fehler:** Reißt RTK bei einem Allowlist-Befehl, MUSS die Roh-Ausgabe durchgereicht werden (fail-open); Häufigkeit im Bericht vermerken.
- **E2 — Zu wenig vergleichbare Storys im Backlog:** Reichen nicht N ≥ 3 vergleichbare Storys, wird der Pilot mit der erreichbaren Anzahl gefahren und die reduzierte Aussagekraft im Bericht offengelegt (kein Hochrechnen).
- **E3 — Gate kippt mit RTK:** siehe AC4 — Befehl nach Klasse C, dokumentieren, nicht maskieren.

## NFRs
- Der Pilot verändert **keinen** dauerhaften Produktivpfad ohne positive AC5-Empfehlung; der Hook ist ein temporäres Mess-Instrument.
- Kein Secret, kein Quelltext, keine Pfade an RTK-Telemetrie (Default-aus verifiziert, AC1).

## Nicht-Ziele
- Keine dauerhafte Aufnahme von RTK ins dev-gui-Scaffold in diesem Piloten (das wäre — bei positiver Empfehlung — eine agent-flow-Scaffold-Story, ADR AC5).
- Keine Änderung der agent-flow-Trennlinie (sie ist Eingangsgröße, nicht Verhandlungsgegenstand).
- Kein Nachbau der RTK-Mechanik (Weg A) in diesem Piloten — der Pilot misst nur; Weg-A-Umsetzung ist eine eigene agent-flow-Story.

## Abhängigkeiten
- agent-flow: `docs/specs/output-token-shaping.md` + `docs/architecture/output-token-shaping.md` (ADR, Eingangsgröße — Trennlinie + Vorab-Empfehlung).
- dev-gui Metrik-Ledger (`.claude/metrics/`) + `metrics-scripts-backfill` (S-344 — liefert die Ledger-Skripte, ohne die `tok_total` nicht erfasst wird; **Reihenfolge-Abhängigkeit**).
- Externe Quelle: `rtk-ai/rtk` (Apache-2.0).
