---
id: rtk-output-shaping-pilot-report
title: RTK-Ausgabe-Diät — Ergebnis-Bericht des Wegwerf-Piloten (S-345)
status: final
area: retro-lernen
version: 1
---

# Ergebnis-Bericht: RTK-Ausgabe-Diät — Wegwerf-Pilot  (`rtk-output-shaping-pilot`)

> Bericht zu Story **S-345** (Feature F-076), Spec [`docs/specs/rtk-output-shaping-pilot.md`](specs/rtk-output-shaping-pilot.md).
> Eingangsgröße: agent-flow-Spike `output-token-shaping` (S-065) + dessen ADR (Trennlinie + Vorab-Empfehlung „C sofort + A mittelfristig, B bedingt").
> **Charakter: Wegwerf-Pilot.** RTK v0.43.0 wurde gehärtet und temporär installiert, gemessen und wieder **rückstandsfrei entfernt**. Kein Produktivpfad, kein Hook, kein dauerhaftes Binary.

## 1. Setup & Härtung (AC1)

- **Version gepinnt:** `rtk 0.43.0` (nicht „latest") — die aktuelle Stable, **nach** dem Patch der Config-Trust-Schwachstelle CVE-2026-45792 (behoben ab v0.32.0).
- **Bezug + Integrität:** Release-Tarball `rtk-aarch64-apple-darwin.tar.gz` direkt von GitHub-Releases geladen, **SHA-256 gegen `checksums.txt` verifiziert** (`8a17e49a…`, Match bestätigt). In den Session-Scratchpad entpackt — **nicht** ins System (`~/.local/bin` unangetastet).
- **Kein Hook (Hot-Path vermieden):** `rtk init` wurde **nicht** ausgeführt — der PreToolUse-Hook (Träger der CVE-Historie: HIGH 7.8 Permission-Gate-Bypass, Config-Trust) wurde **nie** installiert. RTK wurde ausschließlich per direktem `rtk <cmd>` zum Messen aufgerufen.
- **Keine Filter-Config:** weder projekt-lokal (`.rtk/filters.toml`) noch global (`~/.config/rtk/filters.toml`) angelegt — nur RTKs eingebaute Filter, kein trust-relevanter Konfigurationspfad.
- **Telemetrie verifiziert AUS:** `rtk telemetry status` → `consent: never asked / enabled: no`. Datenverzeichnisse zusätzlich per `XDG_*` in den Scratchpad umgelenkt. (Hinweis: RTK schreibt auf macOS zusätzlich ein lokales „tee"-Log unter `~/Library/Application Support/rtk/` — beim Teardown entfernt.)
- **Teardown:** Binary, Scratchpad-Daten und das macOS-tee-Verzeichnis nach der Messung gelöscht.

### 1.1 Supply-Chain-Vorprüfung (AC1 — Belege, vor der Installation erhoben)
Primärquellen: GitHub-API (`rtk-ai/rtk`), Release-Assets, veröffentlichte Security-Advisories, RTK-Doku.
- **Reife/Verbreitung:** Repo erstellt **2026-01-22** (~6 Monate jung), ~70 900 Stars, ~4 400 Forks, kleines Kern-Team (3 Haupt-Contributor). Apache-2.0, quelloffen.
- **Release-Cadence:** sehr hoch — **mehrere Release-Candidate-Builds pro Tag** (z. B. `dev-0.44.0-rc.311…316` innerhalb weniger Tage). Kurze Prüfzeit je Release.
- **Signierung:** Releases tragen **nur `checksums.txt` (SHA-256), keine kryptografische Signatur** (kein `.sig`/`.asc`/sigstore). Integritätsschutz gegen kaputte Downloads, **nicht** gegen eine kompromittierte Build-Pipeline.
- **3 veröffentlichte Advisories, alle im Umschreibe-/Filter-Kern:**
  - `GHSA-7gxq-fvfc-g327` — **HIGH (CVSS 7.8):** Permission-Gate-Bypass im `rtk rewrite` auto-allow.
  - `GHSA-fvvm-949w-qj4w` — **MEDIUM (6.9), CVE-2026-45792:** RTK vertraute projekt-lokaler Filter-Config → **stille Verfälschung der dem LLM gezeigten Ausgabe** (behoben ab v0.32.0; die verwendete v0.43.0 ist gepatcht).
  - `GHSA-fqgj-m2gp-mr3q` — **MEDIUM (6.3):** Command-Injection im OpenClaw-Rewrite-Plugin (`execSync`-Template-String).
- **Positiv:** `SECURITY.md` vorhanden, verantwortliche Offenlegung (Advisories publiziert + gepatcht), verschärftes PR-Review; der Installer verifiziert per Default die SHA-256-Checksumme.
- **Rest-Risiko-Fazit:** Für ein Fremd-Binary im **Bash-Hot-Path** (Hook-Modus) ist die Kombination aus Jugend, täglichem Release-Takt, fehlender Signierung und einer Advisory-Historie, deren Kern gerade die **stille Ausgabe-Verfälschung** ist, das falsche Profil. Der Pilot vermeidet dieses Risiko durch den Hook-freien, gepinnten Wegwerf-Betrieb.

## 2. Methodik (Abweichung von der Spec — transparent)

Die Spec (AC2/AC3) skizzierte „N ≥ 3 `/flow`-Läufe ohne/mit RTK". Der Pilot **weicht bewusst ab** und misst stattdessen **auf Befehlsebene** — aus drei Gründen:

1. **Isolation des Effekts.** RTK wirkt ausschließlich auf **Befehls-Ausgabe**. Auf `/flow`-Ebene ist `tok_total` von LLM-Reasoning-/Generierungs-Token dominiert; die Befehlsausgabe ist nur ein Bruchteil. Ein Vor/Nach-Vergleich ganzer Läufe misst v. a. Story-Streuung, nicht RTK.
2. **Keine Nebenwirkungen.** 6 echte `/flow`-Läufe hätten 6 reale dev-gui-Stories **gelandet** (Merges auf `main`) — das Gegenteil eines Wegwerf-Piloten, und teuer.
3. **Direkter Fidelity-Test.** Die Kernfrage („kürzt RTK das Gate-Signal weg?") lässt sich am Befehl **direkt** prüfen, statt sie aus Gate-Ausgängen zu erschließen.

Gemessen: reale Fabrik-Befehle im dev-gui-Repo, **roh vs. `rtk`-gefiltert**. Token ≈ Bytes/4 (grobe, konsistente Näherung; für einen Größenordnungs-Befund ausreichend).

**Konsequenz für die Story-Historie:** Durch die Befehlsebenen-Methodik entfällt die Auswertung von `tok_total` aus `.claude/metrics/items.jsonl` — die im Board vermerkte Abhängigkeit auf **S-344** (Ledger-Skripte) wird hier faktisch nicht genutzt. Sie bleibt für eine spätere echte `/flow`-Ebenen-Messung relevant, falls je gewünscht.

## 3. Messung: Klasse A — Explorations-Befehle (AC3)

| Befehl | roh (~Token) | rtk (~Token) | Ersparnis |
|---|---:|---:|---:|
| `ls -la` | 501 | 164 | **67 %** |
| `git status` | 44 | 14 | **68 %** |
| `git log --oneline -30` | 688 | 638 | 7 % |
| `grep -rn function client/src` | 13 624 | 4 073 | **70 %** |
| `find client/src -name '*.jsx'` | 1 341 | 252 | **81 %** |

**Befund:** Auf volumenstarken Explorations-Befehlen liefert RTK **reale, deutliche Ersparnis (~65–80 %)** — bei **null Fidelity-Risiko** (diese Ausgaben speisen kein Gate, keinen Verbatim-Beleg). `git log --oneline` ist bereits kompakt → wenig Spielraum (7 %).

## 4. Messung: Klasse B — Gate-kritische Befehle + Fidelity-Gegenprobe (AC3/AC4)

### 4.1 `git diff`
- **`rtk git diff` (Proxy):** 2 403 → 2 395 Token — **~0 %** (praktisch keine Kürzung).
- **`rtk diff -` (dediziert, Diff über stdin):** 9 615 → 9 231 B (~2 404 → ~2 308 Token) — **4 %** auf einem **additions-lastigen** Diff. **Fidelity OK:** die geänderten Zeilen bleiben erhalten, gruppiert als `[file] … (+N -M)` mit den konkreten `+`/`-`-Zeilen.
- **Fazit:** Diff-Ersparnis ist **gering und formabhängig** (neue Dateien lassen sich nicht verlustfrei kürzen); die Fidelity des dedizierten `rtk diff` ist gewahrt, aber der Nutzen marginal.

### 4.2 Test-Ausgabe — der entscheidende Befund
Simulierter Testlauf (240 grüne Zeilen + **1 echter Fehler** + Summary), realistisches Jest-Layout (Fehlerblock direkt vor der Summary):

- **`rtk test`:** 96 % „Ersparnis" — **aber** die Mechanik ist eine **naive Tail-Heuristik**: RTK gibt `OUTPUT (last 5 lines)` + einen Verweis auf ein Log-File aus, **keine** semantische Fehler-Extraktion.
  - Fehler **direkt am Ende** → Assertion (`Expected: 401` / `Received: 200` / `…:42`) bleibt, **aber der Testname** (`● Login › rejects an expired token`) fällt weg (lag >5 Zeilen vorm Ende).
  - Fehler **in der Mitte** (erster Test von vielen, oder mehrere Fehler, oder Coverage-Tabelle danach) → **Fehlersignal komplett verloren**, nur noch „1 failed" + Log-Pfad.
- **`rtk err`:** verlor im selben Lauf sogar `Expected/Received` (behielt nur die `at …:42`-Zeile).

**Fidelity-Urteil: DURCHGEFALLEN für Klasse B (Tests).** RTKs Test-/Err-Filter ist eine layout-abhängige Zeilen-Tail-Heuristik, **kein** signal-erhaltender Filter im Sinne der ADR-Trennlinie (AC1b). Das Fehlersignal überlebt nur zufällig (wenn es in den letzten Zeilen steht). Für das `tester`-Gate der Fabrik heißt das: ein realer Jest-Lauf mit mehreren Fehlern oder Coverage-Ausgabe kann die **Fehlerdiagnose still verlieren** — der Agent sähe „1 failed" ohne die Assertion. Das ist exakt der maskierte-Fehlschlag-Fall (`coder/R02`/`reviewer/R01`-Risiko). Der volle Output landet zwar in einem tee-Log — aber es zu lesen kostet genau die gesparten Token und setzt voraus, dass der Agent der Kurzfassung misstraut.

## 5. Entscheidung & Rückkopplung ans ADR (AC5)

Der Pilot **bestätigt die ADR-Vorab-Empfehlung** und schärft sie mit Messwerten:

- **Weg C (Prompt-Ebene) + Weg A (Eigenbau, Pack-verankert): empfohlen.** Der reale Nutzen konzentriert sich auf **Klasse-A-Explorationsbefehle (~65–80 %)** — genau das kann ein **eigener, einfacher Dedup-/Truncation-Filter** abdecken, den wir vollständig kontrollieren und der Test-/Diff-Ausgabe **nie** anfasst.
- **Weg B (RTK produktiv): nicht empfohlen — abgelehnt.** Zwei Gründe, jetzt empirisch belegt: (1) auf den Gate-kritischen Befehlen (Tests) ist RTKs Filter **unzuverlässig** (naive Tail-Heuristik, Fehlersignal verlierbar); (2) das Supply-Chain-Profil (junges Projekt, tägliche Releases, keine Release-Signierung, 3 Advisories im Kern-Mechanismus inkl. „stille Ausgabe-Verfälschung") passt nicht zu einem Fremd-Binary im Bash-Hot-Path einer Gate-getriebenen Fabrik.

**Konkrete Rückkopplung an das agent-flow-ADR** `docs/architecture/output-token-shaping.md`:
- Die „B nur bedingt"-Zeile in §3.2 zu **„B abgelehnt (messungs-belegt)"** schärfen, mit Verweis auf diesen Bericht und CVE-2026-45792.
- Die Trennlinie (AC1) bestätigen: **Klasse A filterbar (großer, sicherer Nutzen), Klasse B (Tests) nie über eine Tail-Heuristik** — ein Eigenbau-Filter für Klasse B muss **semantisch** sein (Failures/Assertions gezielt behalten) oder Klasse B ganz roh lassen.
- Der **maximal erreichbare Gewinn** liegt im Explorations-Rauschen (Klasse A) — das rechtfertigt Weg A, nicht Weg B.

*(Die ADR-Aktualisierung selbst ist ein Folge-Schritt im agent-flow-Repo — Cross-Repo, nicht Teil dieses dev-gui-PRs.)*

## 6. Rohdaten (Nachvollziehbarkeit)
- Klasse A: Tabelle §3 (Bytes/4-Näherung, gemessen im dev-gui-Repo-Root gegen `origin/main`-Stand mit S-344).
- Klasse B: §4.1 (git diff, additions-lastiger Diff `HEAD~1..HEAD`) + §4.2 (synthetischer Testlauf, zwei Layout-Varianten + `rtk err`-Vergleich).
- Alle Rohläufe im Session-Scratchpad erzeugt und mit dem RTK-Binary gemeinsam entfernt (Wegwerf-Prinzip).
