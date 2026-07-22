---
id: regression-local-execution
title: target:local-Regressionslauf end-to-end lauffähig — Vorbedingungen herstellen statt blind starten
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: target:local-Regressionslauf end-to-end lauffähig  (`regression-local-execution`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate). **Security-relevant** (App-Secret-Injektion, lokaler Docker-Zugriff).
>
> **Verhältnis zu [[regression-run]]:** [[regression-run]] definiert den `RegressionRunner`-Boundary, die `target`-Weiche (AC11), die local-Erreichbarkeitsprüfung (AC5), das Frisch-Ausrollen (AC7) und die Diagnose-Pflicht bei Frühausfall (AC10). Diese Spec **verschärft die Vorbedingungen** des `local`-Pfads: der Runner **stellt** seine Ausführungs-Vorbedingungen aktiv **her** (Test-Dependencies, Browser, erreichbare Ziel-Adresse, App-Secrets, Test-Config), statt `npx playwright test` blind zu starten und erst am fehlenden CTRF-Ergebnis zu scheitern. Sie **dupliziert** die dortigen AC nicht, sondern referenziert sie.

## Zweck
Ein `target: local`-Regressionslauf, der aus der dev-gui-Oberfläche gestartet wird, schließt **reproduzierbar grün** ab (Referenzfall: flashrescue-Verbund-Suite, `FLASHRESCUE_REGRESSION_ALLOW_REAL_SEND`-Schritte kontrolliert übersprungen), ohne manuellen Eingriff im Ausführungskontext. Dafür stellt der Runner vor dem Test-Start seine Vorbedingungen her und meldet jede nicht herstellbare Vorbedingung als klaren, diagnostizierbaren Fehlzustand statt als kryptischen Spätausfall.

## Kontext / Designnuancen (bindend)
- **Vorbedingung herstellen, nicht blind starten:** Der `local`-Pfad prüft **vor** dem eigentlichen Test-Kommando, dass (1) Test-Dependencies + Browser vorhanden sind, (2) eine erreichbare Ziel-Adresse bestimmbar ist, (3) die verlangten App-Secrets in der Kind-Env liegen und (4) das Testobjekt mit korrekter Test-Config provisioniert ist. Jede nicht herstellbare Vorbedingung endet als **terminaler** Fehlzustand mit secret-freier Diagnose ([[regression-run]] AC10) — **nie** der bisherige unspezifische „kein CTRF-Ergebnis gefunden"-Spätausfall (verifizierter Befund 2026-07-22).
- **Deterministik unverändert:** Alle hier geforderten Vorbereitungsschritte laufen weiterhin **ohne** `claude`/Agent/API-Key ([[regression-run]] AC1). `npm ci`/`playwright install`/Provisionierung sind deterministische Kommandos, kein LLM-Aufruf.
- **Secret-Floor (hart):** App-Secrets werden ausschließlich in die **Kind-Env** des Playwright-Prozesses injiziert — **nie** geloggt, **nie** persistiert, **nie** in argv, WS oder Audit (globale Owner-Vorgabe „keine Secrets in Dateien/Commits/Notizen"; [[regression-run]] NFR; [[deploy-bitwarden-gpg-injection]]-Modell).
- **Deployment-Bewusstsein:** Läuft der Runner selbst in einem Container (Deployment `docker`), ist ein Nachbar-Container-Testobjekt **nie** über `127.0.0.1` erreichbar — die Ziel-Adressierung muss den Container-/Host-Betrieb unterscheiden (Befund 3).
- **REAL_SEND-Gate NIE automatisch:** Die hart hinter `FLASHRESCUE_REGRESSION_ALLOW_REAL_SEND=1` (bzw. dem generischen REAL_SEND-Gate) liegenden Schritte (echtes Mainnet-Gas) werden vom Runner **nie** gesetzt; sie skippen kontrolliert, der Rest der Suite muss grün werden können.

## Annahmen
> Owner zum Lauf **nicht erreichbar** (Auftrag) und kein `AskUserQuestion`/`Task` im Subagent-Kontext (projekt-lokale Lesson 2026-07-15) — folgende Detailentscheidungen wurden **konservativ/fail-safe** getroffen und sind im Lauf-Output als offene Entscheidungen geflaggt.
- **A1 (Browser-Bereitstellung — Infrastruktur-Entscheidung, konservativ):** Vorzugsweise ein **Playwright-fähiges dev-gui-Basis-Image** mit vorinstallierten Browsern + OS-Deps (schnellster, reproduzierbarster Lauf). Konservativer, image-unabhängiger Fallback: ein **idempotenter** `npx playwright install --with-deps chromium`-Schritt im Ausführungskontext. Die endgültige Wahl (Image-Rebuild vs. Install-Schritt) ist eine **Architektur-/Infrastruktur-Entscheidung**, die in `docs/architecture.md` als **ADR** zu verankern ist (`architekt`-Scope) — im Lauf-Output geflaggt. AC2 fordert das beobachtbare Ergebnis („Browser verfügbar oder klarer Vorbedingungsfehler"), nicht den Mechanismus.
- **A2 (Fehlende Secrets — kontrollierter Skip, konservativ):** Fehlt ein von der Suite verlangtes Secret, gilt das **Bestandsverhalten der Suite** (`test.skip` in `beforeAll`) als definierter Ausgang — der Lauf startet **nicht** base-url-/secret-los ins Blaue. Ob ein fehlendes Secret stattdessen als Vorbedingungsfehler gemeldet werden soll, ist eine additive Owner-Entscheidung (geflaggt).
- **A3 (Test-Config-Mechanik):** Die konkrete Provisionierungs-Mechanik des Test-Backends (z.B. `fee.prozent: 0`) ist **projekt-/deployment-spezifisch** und ein `architekt`-/Implementierungs-Detail; AC9 fordert das beobachtbare Ergebnis (Suite kann grün werden), nicht den Mechanismus. **Keine** Schema-/Infra-Annahme wird hier erfunden.
- **A4 (Host-Port-Auflösung):** Der auf den Host gemappte Port des Ziel-Containers (Befund 3, `8080→8081`) wird deployment-bewusst aus dem tatsächlichen Port-Mapping ermittelt (nicht der Container-interne EXPOSE-Port); die genaue Ermittlungsquelle (Docker-Inspect via socket-proxy) ist `architekt`-/Implementierungs-Detail.

## Main Success Scenario
1. Owner startet einen `target: local`-Lauf (Referenzfall: flashrescue-Verbund) über den Ausführen-Dialog ([[regression-run]] Main Success Scenario).
2. Der Runner stellt die **Test-Dependencies** im Projekt-Klon her (`npm ci`, Fallback `npm install`), falls `node_modules`/`@playwright/test` fehlen (AC1).
3. Der Runner stellt sicher, dass die **Playwright-Browser** (mind. chromium) im Ausführungskontext verfügbar sind (AC2).
4. Der Runner bestimmt eine **erreichbare, deployment-bewusste Ziel-Adresse** (AC4–AC6) und setzt `REGRESSION_BASE_URL` darauf.
5. Der Runner injiziert die verlangten **App-Secrets** sicher in die Kind-Env (AC7/AC8).
6. Das Testobjekt ist mit der nötigen **Test-Config** provisioniert (AC9); REAL_SEND-Schritte bleiben ungesetzt (AC10).
7. `npx playwright test` läuft; die Referenz-Suite schließt **grün** ab (REAL_SEND-Schritte kontrolliert übersprungen), Ergebnis-Übergabe wie [[regression-run]] AC9 (AC11).

## Alternative Flows
- **E1 — Deps/Browser nicht herstellbar:** `npm ci`/`playwright install` scheitert → terminaler `precondition-error`/`error` mit secret-freier Diagnose ([[regression-run]] AC10), **kein** blinder Playwright-Start (AC1/AC2/AC3).
- **E2 — Port nicht bestimmbar:** kein Port aus `.claude/profile.md` auflösbar → `precondition-error` „lokaler Test-Port nicht bestimmbar" ([[regression-run]] AC10), **kein** stiller base-url-loser Lauf (AC5).
- **E3 — Ziel nicht erreichbar:** deployment-bewusste Adresse gebildet, aber nicht erreichbar → bestehender Vorbedingungsfehler „Applikation lokal nicht gestartet" ([[regression-run]] AC5) — nun gegen die **richtige** Adresse geprüft (AC6).
- **E4 — Secret fehlt:** siehe A2 (kontrollierter Skip, kein stiller Lauf).

## Acceptance-Kriterien

### Test-Dependencies & Browser (Befund 1)
- **AC1** — **Test-Dependencies herstellen:** Vor `npx playwright test` stellt der Runner sicher, dass die Test-Dependencies im Projekt-Klon installiert sind — fehlt `node_modules` **oder** `@playwright/test`, führt er `npm ci` (Fallback `npm install`) im Klon-Root aus, **bevor** der Test startet. Schlägt die Installation fehl → terminaler `precondition-error`/`error` mit secret-freiem Grund ([[regression-run]] AC10), **kein** blinder Test-Start.
- **AC2** — **Browser verfügbar:** Die Playwright-Browser (mind. `chromium`) sind im Ausführungskontext verfügbar — bereitgestellt als **saubere Infrastruktur** (A1: Playwright-fähiges Basis-Image **oder** idempotenter `npx playwright install --with-deps chromium`-Schritt), **nicht** als ad-hoc-npx-Zufall pro Lauf. Fehlen die Browser beim Lauf → terminaler Vorbedingungsfehler mit Diagnose ([[regression-run]] AC10) statt kryptischem Playwright-`Cannot find module`-Absturz.
- **AC3** — **Vorbedingung VOR dem Test-Kommando:** Die Herstellung/Prüfung „Deps + Browser vorhanden" läuft **vor** dem eigentlichen `npx playwright test`; ist sie nicht herstellbar, endet der Lauf als terminaler Fehlzustand mit Diagnose ([[regression-run]] AC10) — **nie** der bisherige unspezifische „Regressionslauf beendet, aber kein CTRF-Ergebnis gefunden"-Spätausfall (`NO_CTRF_MESSAGE`, Befund 1).

### Port-Auflösung & deployment-bewusste Ziel-Adressierung (Befunde 2 + 3)
- **AC4** — **Robust gegen Inline-Kommentare:** `preview_port`/`container_port` aus `.claude/profile.md` werden auch dann korrekt gelesen, wenn nach der Zahl **Whitespace + ein Inline-Kommentar** folgt (z.B. `container_port: 8080    # EXPOSE aus dem Dockerfile`). Gilt für **beide** Leser (`readLocalPreviewPort` **und** `readLocalRolloutConfig`, dasselbe Muster — Befund 2a).
- **AC5** — **port=null degradiert nicht mehr still:** Findet der Runner bei `target: local` **keinen** Port, endet der Lauf als klarer **`precondition-error`** „lokaler Test-Port nicht bestimmbar" (Diagnose nach [[regression-run]] AC10) — **statt** Erreichbarkeitsprüfung, Frisch-Ausrollen **und** `REGRESSION_BASE_URL`-Setzen still zu überspringen und Playwright base-url-los zu starten (Befund 2b, Zeilen 726–752 des Alt-Verhaltens).
- **AC6** — **Deployment-bewusste Ziel-Adressierung:** Läuft der Runner selbst in einem Container (Deployment `docker`), adressiert er das Nachbar-Container-Testobjekt über die **auf den Host gemappte** Adresse (`host.docker.internal:<hostPort>`, A4), **nicht** `127.0.0.1:<container-internem-Port>`; im Host-Betrieb bleibt `127.0.0.1:<port>`. Die local-Erreichbarkeitsprüfung ([[regression-run]] AC5) **und** `REGRESSION_BASE_URL` nutzen **dieselbe** aufgelöste Adresse (Befund 3). Der Selbsttest-Sonderfall (dev-gui gegen sich selbst, [[regression-run]] AC8) bleibt unberührt.

### App-Secret-Injektion (Befund 4, Secret-Anteil) — Security-Floor
- **AC7** — **Sichere Injektion:** Die von der Suite verlangten App-Secrets (Referenzfall: `ALCHEMY_API_KEY` + die zwei Wallet-Key-Env-Vars aus der Datentabelle) werden über das bestehende **Bitwarden/GPG-Modell** ([[deploy-bitwarden-gpg-injection]]-Linie, `readItemPassword`/Session-Modell) abgerufen und **ausschließlich in die Kind-Env** des Playwright-Prozesses injiziert. **Security-Floor (hart, testbar):** die Werte erscheinen **nie** in Log, WS, Audit, argv oder auf Platte (Grep-/Verhaltens-prüfbar); der Runner persistiert nichts davon (analog [[regression-run]] NFR).
- **AC8** — **Deklarativ, nicht aus Testdaten:** Welche Secret-Namen injiziert werden, ist **konfiguriert/deklariert** (nicht aus Test-/Datendateien der Suite gelesen — [[regression-run]] `run-regression.sh`-Konvention). Fehlt ein verlangtes Secret, ist das Verhalten **definiert** (A2: kontrollierter Suite-`test.skip`), **nie** ein stiller secret-loser Lauf, der dann rot/irreführend endet.

### Test-Config & REAL_SEND-Gate (Befund 4, Config-Anteil)
- **AC9** — **Test-Config provisioniert:** Das frisch ausgerollte/erreichbare Testobjekt ist mit der für den Referenzfall nötigen Test-Config provisioniert (z.B. `fee.prozent: 0` für den Freundschaftsfall), sodass die Suite grün werden **kann**. Mechanik projekt-/deployment-spezifisch (A3, `architekt`-Detail) — AC fordert nur das beobachtbare Ergebnis.
- **AC10** — **REAL_SEND nie automatisch scharf:** Der Runner setzt `FLASHRESCUE_REGRESSION_ALLOW_REAL_SEND` (bzw. das generische REAL_SEND-Gate) **nie**; die dahinter liegenden Schritte skippen kontrolliert, der Rest der Suite muss grün werden können.

### Integrations-Acceptance (Referenzfall)
- **AC11** — **Grüner Referenzlauf:** Ein `target: local`-Lauf der flashrescue-Verbund-Suite lässt sich aus der dev-gui-Oberfläche starten und schließt **reproduzierbar grün** ab (REAL_SEND-Schritte kontrolliert übersprungen), **ohne** manuellen Eingriff im Ausführungskontext. Ergebnis-Übergabe an den Store wie [[regression-run]] AC9. Setzt AC1–AC10 als Vorbedingungen voraus.

## Verträge
- **Kein neuer HTTP-Endpunkt** — die Vorbedingungs-Herstellung hängt am bestehenden `POST /api/projects/:slug/regression-run`-Lauf ([[regression-run]] §Verträge), zwischen Lauf-Start und Playwright-Aufruf im `local`-Pfad (`#runLifecycle`).
- **Ziel-Adresse (AC6):** `{ container-Betrieb: "host.docker.internal:<hostPort>", host-Betrieb: "127.0.0.1:<port>" }` → dieselbe Adresse für Erreichbarkeitsprüfung **und** `REGRESSION_BASE_URL`.
- **Secret-Quelle (AC7):** Bitwarden-Item je Secret-Name (Konvention analog [[deploy-bitwarden-gpg-injection]] AC15) → Kind-Env-Var; **nie** Response/Log/WS/Audit/argv/Platte.
- **Diagnose-Meldungen (AC1/AC2/AC3/AC5):** feste, secret-freie Meldungs-Menge ([[regression-run]] AC10) — **nie** roher Prozess-/Fehler-Output.

## Edge-Cases & Fehlerverhalten
> Alle Fehlzustände sind terminale Lauf-Zustände und unterliegen der Diagnose-Pflicht [[regression-run]] AC10 (Datensatz + secret-freier `reason` im Ergebnis-Store).
- `npm ci` scheitert (kein Lockfile / Netzfehler / inkompatible Node-Version) → `precondition-error`/`error` mit secret-freier Diagnose; Suite nicht gestartet.
- `playwright install` scheitert (kein Netz / fehlende OS-Deps) → terminaler Fehlzustand mit Diagnose; **kein** blinder Test-Start.
- `.claude/profile.md` mit Inline-Kommentar am Port (Befund 2a) → Port trotzdem korrekt aufgelöst (AC4).
- Kein Port auflösbar (Befund 2b) → `precondition-error` „lokaler Test-Port nicht bestimmbar" (AC5), **kein** base-url-loser Lauf.
- Runner im Container, Ziel im Nachbar-Container (Befund 3) → Adressierung über `host.docker.internal:<hostPort>` (AC6); `127.0.0.1` würde auf den dev-gui-Container selbst zeigen.
- Secret in Bitwarden nicht gefunden/abrufbar → definierter Ausgang (A2: kontrollierter Skip), **nie** stiller secret-loser Lauf; Abruf-Fehler secret-frei diagnostiziert.
- Test-Config nicht provisionierbar → die Suite scheitert als normaler Playwright-Testfehlschlag (CTRF `failed`), **nicht** als Runner-`error` (der Runner provisioniert das Backend-Config nicht selbst, wenn A3 es der Suite/Infra überlässt) — bzw. terminaler Fehlzustand, falls der Runner die Provisionierung übernimmt (Implementierungs-Detail A3).

## NFRs
- **Sicherheit (Floor, hart):** App-Secrets nur in Kind-Env, nie geloggt/persistiert/in argv/WS/Audit (AC7); hinter Access, identitäts-/rollengeschützt, audit-first ([[regression-run]] AC3, unverändert); kein API-Key/`claude`-Prozess.
- **Determinismus:** alle Vorbereitungsschritte sind deterministische Kommandos, kein LLM-Aufruf ([[regression-run]] AC1).
- **Idempotenz:** `npm ci`/`playwright install`/Provisionierung sind wiederholbar ohne Nebenwirkung (mehrfacher Lauf hinterlässt keinen inkonsistenten Zustand).

## Nicht-Ziele
- Neu-Definition des `RegressionRunner`-Boundary, der `target`-Weiche, der Frisch-Ausroll-Mechanik oder der Diagnose-Pflicht ([[regression-run]]).
- `ephemeral-infra`/`url`-Pfade ([[regression-run]] AC11/AC12).
- Ergebnis-Ablage/Ansicht/Benachrichtigung ([[regression-result-store]]/[[regression-result-view]]/[[regression-failed-notification]]).
- Scope-Vertrag Reader↔Runner (Verbund ohne id) — separater Fix in [[regression-run]] AC13.
- Neu-Definition des Bitwarden/GPG-Zugangs-Modells ([[deploy-bitwarden-gpg-injection]]) — hier nur Wiederverwendung.

## Abhängigkeiten
- [[regression-run]] (Runner-Boundary, `local`-Pfad, Erreichbarkeitsprüfung AC5, Frisch-Ausrollen AC7, Diagnose-Pflicht AC10, Verträge).
- [[deploy-bitwarden-gpg-injection]] (Bitwarden/GPG-Zugangs-Modell, `readItemPassword`/Session-Caching) — wiederverwendet für die Secret-Injektion.
- Bestehende cicd/preview-Rollout-Mechanik (pull + recreate + Readiness, lokaler Docker via socket-proxy) — für Test-Config-Provisionierung / Host-Port-Auflösung mitgenutzt.
- `docs/architecture.md` — ADR für die Browser-Bereitstellung (A1, `architekt`-Scope, offen).
