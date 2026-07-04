---
id: plugin-auto-update
title: Plugin-Auto-Update beim Container-Boot — Fabrik-Werkzeuge bei jedem Start aktualisieren
status: draft
area: deployment
version: 1
---

# Spec: Plugin-Auto-Update beim Container-Boot  (`plugin-auto-update`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der dev-gui-Container installiert das agent-flow-Plugin heute **einmalig** beim ersten Boot und aktualisiert es danach **nie** (`docker-entrypoint.sh`, „already installed"-Zweig). Dadurch bleibt die im Container installierte Fabrik-Version auf dem Stand des ersten Starts hängen — neue oder umbenannte Fabrik-Befehle (z.B. `/agent-flow:reconcile`) fehlen im Container und lösen im Panel **nicht** auf. Diese Spec bringt die Fabrik-Werkzeuge bei **jedem** Boot auf den aktuellen Stand — **best-effort/guarded**, ohne den Server-Start zu gefährden.

## Verhalten
1. Bei **jedem** Container-Boot bringt `docker-entrypoint.sh` das agent-flow-Plugin auf den aktuellen Stand:
   - Ist das Plugin **noch nicht** installiert → Marketplace hinzufügen + Plugin **installieren** (bisheriges Verhalten, unverändert).
   - Ist das Plugin **bereits** installiert → Marketplace **aktualisieren** (`claude plugin marketplace update`) **und** Plugin **aktualisieren** (`claude plugin update agent-flow@agent-flow` — **qualifizierter** Name, analog zum Install-Kommando; der bloße Name `agent-flow` schlägt live mit Exit 1 „not found" fehl, siehe Verträge) bzw. das äquivalente CLI-Kommando, sodass die neueste veröffentlichte Version aktiv ist.
2. Der Aktualisierungs-/Installationsblock ist **guarded/best-effort** analog zum bestehenden Install-Block: schlägt ein Schritt fehl, **bricht der Container nicht ab** (`set -e`-sicher). Der Server startet, GUI und Status funktionieren; nur `/agent-flow:*` sind dann ggf. veraltet.
3. Der Block ist **idempotent**: mehrfache Boots konvergieren zum selben Zustand; ein bereits hinzugefügter Marketplace oder eine bereits aktuelle Version führen **nicht** zu einem harten Fehler/Abbruch.
4. Erfolg und Misserfolg sind im Boot-Log **unterscheidbar** markiert (Erfolgs-Marker vs. Warnung auf stderr).
5. Nach einem erfolgreichen Boot lösen `/agent-flow:reconcile` **und** die übrigen aktuellen Skills auf (die installierte Plugin-Version entspricht der neuesten veröffentlichten).

## Acceptance-Kriterien
- **AC1** — Bei installiertem Plugin führt der Entrypoint einen **Aktualisierungs-Pfad** aus (Marketplace-Update **und** Plugin-Update), statt nur „already installed" zu loggen und nichts zu tun. Bei fehlendem Plugin bleibt der **Installations-Pfad** (Marketplace add + install) erhalten.
- **AC2** — Der Update-/Install-Block ist **fehler-isoliert**: ein fehlschlagendes Marketplace-/Update-/Install-Kommando führt **nicht** zum Abbruch des Entrypoints (Exit ≠ 0 des Kommandos wird abgefangen); der Server-Start (nachfolgende Schritte) wird erreicht.
- **AC3** — Der Block ist **idempotent**: zweimaliges Ausführen des Entrypoint-Update-Pfades (bereits vorhandener Marketplace / bereits aktuelle Version) endet ohne harten Fehler und ohne doppelte/inkonsistente Installation.
- **AC4** — Bei erfolgreichem Update erscheint im Boot-Log ein eindeutiger **Erfolgs-Marker** mit dem Wort **`plugin updated`** (bzw. `plugin installed` im Erstinstallations-Pfad); bei Fehlschlag erscheint eine **Warnung auf stderr**, die nennt, dass `/agent-flow:*` ggf. veraltet ist.
- **AC5** — Nach dem Boot ist das Plugin auf der neuesten veröffentlichten Version (verifizierbar über `claude plugin list`/Versionsstand), sodass `/agent-flow:reconcile` auflöst. (Testbar über die Skript-Struktur/den ausgeführten Update-Pfad; die reale Plugin-Auflösung ist Integrationsebene.)

## Verträge
- **Datei:** `docker-entrypoint.sh`, Abschnitt „agent-flow plugin auto-provision" (aktuell ~Zeile 43, `if ! claude plugin list … grep -q agent-flow; then <install>; else echo "already installed"; fi`).
- **CLI-Kommandos (best-effort, jeweils Exit-Code abgefangen):**
  - Erstinstallation: `claude plugin marketplace add Studis-Softwareschmiede/agent-flow` + `claude plugin install agent-flow@agent-flow` (unverändert).
  - Aktualisierung: `claude plugin marketplace update` + `claude plugin update agent-flow@agent-flow` (**qualifizierter** Name — live verifiziert: der bloße Name `agent-flow` scheitert in allen Scopes mit Exit 1 „Plugin \"agent-flow\" not found"; oder das äquivalente, vom installierten Claude-CLI unterstützte Update-Kommando).
- **Shell-Kontext:** `set -euo pipefail` ist global aktiv; der Block muss seine Fehler **lokal** neutralisieren (bestehendes Muster: `2>/dev/null`, `if … then … else <warn> fi`, kein nacktes fehlschlagendes Kommando unter `set -e`).
- **Reihenfolge:** Der Update-/Install-Block läuft **vor** dem gh-Auth-Bootstrap (der `PLUGIN_ROOT` unter `$HOME/.claude/plugins/cache/agent-flow` sucht) — die bestehende Reihenfolge bleibt erhalten, damit ein frisch aktualisiertes Plugin auch die aktuelle `ensure-gh-auth.sh` liefert.

## Edge-Cases & Fehlerverhalten
- **Marketplace-add auf bereits vorhandenem Marketplace** → kein harter Fehler/Abbruch (idempotent behandeln, AC3).
- **`claude plugin update` schlägt fehl** (Netz/Registry down) → Warnung, Server startet trotzdem (AC2/AC4); die Alt-Version bleibt aktiv.
- **`claude`-CLI kennt das Update-Unterkommando nicht** (älteres CLI) → Fehler wird abgefangen, Warnung statt Abbruch; Erstinstallations-Pfad bleibt funktionsfähig.
- **Offline-Boot** → Update schlägt best-effort fehl, GUI/Status weiterhin verfügbar.

## NFRs
- **Robustheit:** Der Server-Start darf **niemals** an einem Plugin-Update scheitern (Verfügbarkeit vor Aktualität).
- **Beobachtbarkeit:** Boot-Log macht Erfolg/Fehlschlag ohne zusätzliche Tools erkennbar (Marker + stderr-Warnung).
- **Sicherheit:** Keine Secrets ins Log; der bestehende `GH_TOKEN`-Umgang (insteadOf-URL, kein Token-Log; späteres `unset`) bleibt unverändert. Keine neue Trust-Boundary — nur ein weiterer best-effort-Provisioning-Schritt im bestehenden Entrypoint.

## Nicht-Ziele
- Versions-Pinning/Rollback-Mechanismus für das Plugin (immer „neueste veröffentlichte Version").
- Änderungen am Server-Code, an der GUI oder am `/api/command`-Vertrag.
- Die eigentliche Reconcile-Logik oder die Audit-Log-Anzeige (→ [[spec-audit-view]]).

## Abhängigkeiten
- Bestehender `docker-entrypoint.sh` (Login-Persistenz, git-credential-helper, gh-Auth-Bootstrap — alle unverändert).
- **agent-flow** Marketplace/Plugin (`Studis-Softwareschmiede/agent-flow`) — liefert `/agent-flow:reconcile` und die übrigen Skills.
