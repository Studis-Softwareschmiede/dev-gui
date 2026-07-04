---
id: ghcr-image-list-app-token
title: GHCR-Image-Liste zuverlässig unter dem GitHub-App-Token (Listen-Pfad reparieren)
status: draft
area: deployment
version: 1
---

# Spec: GHCR-Image-Liste unter App-Token (`ghcr-image-list-app-token`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate).
> **Fortschreibung** von [[ghcr-image-list]] (S-154): die dort spezifizierten Endpunkte + Read-Models bleiben unverändert; **diese Spec repariert ausschließlich den Auflist-Pfad**, der mit dem GitHub-App-Installation-Token in Produktion fehlschlägt. **App-Token-only bleibt Vorgabe** ([[github-app-token-unification]], S-146/S-149) — **kein** `GH_TOKEN`-Fallback.

## Zweck
Im Live-Test (2026-06) deckte der erste echte Deploy-Versuch auf: das Image-Dropdown im Deploy-Menü ([[deploy-lifecycle]] AC10) bleibt **leer**, weil `GET /api/github/packages` eine leere Liste liefert. **Ursache (live verifiziert):** der bisher genutzte Listen-Endpunkt `GET https://api.github.com/orgs/{ORG}/packages?package_type=container` (`src/GitHubPackagesReader.js:195`) antwortet mit dem **GitHub-App-Installation-Token** mit `400 "Invalid argument"` — während die **Einzel**-Endpunkte (`GET /orgs/{org}/packages/container/{name}` und `.../{name}/versions`) mit **demselben** Token `200` liefern. Die Images existieren (u.a. `sandbox-3` public, `dev-gui`); nur das **Auflisten** scheitert. Diese Spec macht das **Auflisten der Org-Container-Images unter dem App-Token zuverlässig**, ohne den App-Token-only-Floor aufzuweichen.

> **Annahme / offene Frage für `architekt`/`coder`** (dokumentiert, nicht entschieden): Plausibelste Wurzel ist eine **fehlende „Packages: Read"-Permission der GitHub-App** (org-/installation-level). Ist das die Ursache, ist die korrekte REST-Listen-Abfrage ggf. bereits ausreichend und der Lösungsweg reduziert sich auf eine **Setup-Vorbedingung** (App-Permission nachziehen) statt eines API-Wechsels. `coder`/`architekt` verifizieren das live und dokumentieren das Ergebnis (siehe AC6 + Verträge → „Setup-Vorbedingung").

## Verhalten
1. **Boundary unverändert:** Der einzige Ort, der die GitHub-Packages-API anspricht, bleibt der GitHub-Packages-Reader-Boundary (`GitHubPackagesReader`); das Token kommt **ausschließlich** über den injizierten App-Token-Provider (`() => getToken()`, S-146 AC5). Es gibt **keinen** `process.env.GH_TOKEN`-Fallback ([[github-app-token-unification]] AC9). Org bleibt fest = `Studis-Softwareschmiede` (kein SSRF).
2. **Zuverlässiges Auflisten:** `listPackages()` liefert mit dem App-Token die **tatsächlich vorhandenen** Container-Pakete der Org — also eine **nicht-leere** Liste, wann immer Pakete existieren und das Token gültig + ausreichend berechtigt ist. Der Lösungsweg ist **frei wählbar** (`architekt`/`coder`), solange App-Token-only + Boundary + graceful Degradation erhalten bleiben. Zulässige Wege (Vorschläge, nicht-bindend):
   - (a) **Korrekter REST-Listen-Aufruf** unter App-Token (falls das `400` an einem falschen Parameter/Header oder einer fehlenden, dann nachgezogenen App-Permission lag — siehe AC6 + Setup-Vorbedingung);
   - (b) **GraphQL Packages-API** (`organization.packages(packageType: CONTAINER)`), falls REST-Listen unter App-Token nicht freigeschaltet ist;
   - (c) **Ableitung über die der App-Installation zugänglichen Repos** (`GET /installation/repositories` o.ä.) und je Repo/Paket die **funktionierenden Einzel-Endpunkte** (`GET /orgs/{org}/packages/container/{name}`) abfragen, deren `200`-Verhalten unter App-Token live belegt ist.
3. **Read-Model unverändert:** Das Ergebnis bleibt `ImagePackage[]` mit `{ name, fullImageRef, visibility, htmlUrl, updatedAt }` aus [[ghcr-image-list]] (AC2); `fullImageRef = ghcr.io/<org>/<name>` (lowercase, ohne Tag). Sortierung deterministisch (alphabetisch nach `name`). Der Tag-Pfad (`/{name}/tags`) bleibt unverändert ([[ghcr-image-list]] AC3) — er funktioniert bereits unter dem App-Token.
4. **Graceful Degradation (verschärft, nicht aufgeweicht):** Token nicht auflösbar / GitHub unerreichbar / vollständiger API-Fehler → **leere Liste** + optionales `errors`-Feld, immer 200, **kein** Crash, **kein** Token-Leak (analog [[ghcr-image-list]] AC5). **Neu für Variante (c):** schlägt die Einzelabfrage **einzelner** Pakete fehl, während andere gelingen, liefert der Endpunkt die **erfolgreich** aufgelösten Pakete (Teil-Ergebnis) plus ein `errors`-Eintrag je gescheitertem Paket — **kein** All-or-Nothing-Leerfall, solange wenigstens ein Paket auflösbar ist.

## Acceptance-Kriterien

### Auflisten unter App-Token
- **AC1** — `GET /api/github/packages` liefert mit gültigem, ausreichend berechtigtem App-Token eine **nicht-leere** `{ packages: ImagePackage[] }`-Antwort, wenn die Org Container-Pakete besitzt. (Testbar: gemockter Fetch/Boundary, der den heute beobachteten Fehlerfall des reinen Org-Listen-Endpunkts (`400 "Invalid argument"`) abbildet, liefert über den gewählten Lösungsweg trotzdem die vorhandenen Pakete — die Liste ist nicht leer.) Das Read-Model (`{ name, fullImageRef, visibility, htmlUrl, updatedAt }`) und die alphabetische Sortierung aus [[ghcr-image-list]] AC2 bleiben erfüllt.
- **AC2** — Das App-Token wird **ausschließlich** über den injizierten Provider bezogen; es existiert **kein** `process.env.GH_TOKEN`-Pfad und **kein** zweiter GitHub-API-Sprecher (Grep-prüfbar: nur `GitHubPackagesReader` spricht `api.github.com`/GraphQL für Packages an). (Testbar: Grep + Provider-Injektion-Test.)

### Teil-Fehler-Robustheit (relevant für die Einzel-Endpunkt-Variante)
- **AC3** — Gelingt die Auflösung **einiger** Pakete, während **einzelne** fehlschlagen, liefert der Endpunkt die erfolgreich aufgelösten Pakete (Teil-Ergebnis) **plus** ein `errors: [{ scope, errorClass }]`-Feld je gescheitertem Paket; Status bleibt 200. (Testbar: gemockter Boundary mit 1 fehlerhaftem + N erfolgreichen Paketen → Liste enthält die N, `errors` enthält das eine, kein Crash.) Wählt `coder` die REST-/GraphQL-Listen-Variante (einziger Call), ist dieses AC erfüllt, sobald dieser Call sauber degradiert (kein Teil-Fehler-Modus möglich → trivial erfüllt).

### Degradation & kein Leak (Floor)
- **AC4** — Token nicht auflösbar / GitHub vollständig unerreichbar / vollständiger API-Fehler → `{ packages: [] }` (+ optional `errors`), Status 200, **kein** 5xx, **kein** Crash. (Testbar: Provider gibt `undefined`; Fetch wirft.)
- **AC5** — Das App-Token (und ein etwaiger nachgelagerter Einzelpaket-Token) erscheint **nie** in Response, Log, Fehlertext, WS-Stream, Argv oder Frontend-Bundle; `errors`-Einträge enthalten nur `scope` + `errorClass` ohne sensible Details (security/R01). (Testbar: Response/Log-Pfade secret-frei.)

### Setup-Vorbedingung dokumentieren
- **AC6** — Liegt die Ursache an einer **fehlenden App-Permission** („Packages: Read", org-/installation-level), wird dies als **Setup-Vorbedingung** festgehalten: (a) in dieser Spec unter „Verträge → Setup-Vorbedingung" konkretisiert (welche Permission, wo gesetzt, dass Installation-Token sie danach trägt) und (b) sofern eine projektweite Setup-/Runbook-Doku existiert, dort verlinkt. (Testbar/prüfbar: `coder`/`reviewer` belegen live, ob die korrekte REST-Liste nach Permission-Nachzug `200` liefert; das Ergebnis ist in der Spec dokumentiert — kein offener Platzhalter.)

## Verträge
> Endpunkt-/Read-Model-Verträge sind in [[ghcr-image-list]] kanonisch; hier nur die **Reparatur-Garantien** des Auflist-Pfads.

- **`GET /api/github/packages`** → `200 { packages: ImagePackage[], errors?: [{ scope, errorClass }] }` (unverändert zu [[ghcr-image-list]], jetzt mit der Garantie: nicht-leer bei vorhandenen Paketen + gültigem/berechtigtem App-Token).
- **`ImagePackage`** unverändert: `{ name, fullImageRef, visibility, htmlUrl, updatedAt }`, `fullImageRef = ghcr.io/<org>/<name>` (lowercase).
- **Gewählter Upstream-Pfad (live-verifiziert 2026-06-18, Variante c):**
  1. `GET /installation/repositories?per_page=100` → liefert Repo-Namen der App-Installation (live: agent-flow, sandbox-2, sandbox-3, sandbox-flutter, dev-gui, climatedataanalyser).
  2. Für jeden Repo-Namen: `GET /orgs/{org}/packages/container/{name}` → 200 wenn Container-Image existiert, 404 wenn nicht (live: 5 von 6 Repos haben Images). Probes laufen parallel (Promise.allSettled).
  3. Ergebnis: ImagePackage[] aus den 200-Probes; 404-Probes werden still übersprungen (kein Fehler).
  - Der REST-Org-Listen-Endpunkt (`GET /orgs/{org}/packages?package_type=container`) ist **nicht nutzbar** mit App-Installation-Token (live: `400 Invalid argument`, nicht Permission-abhängig — permanent).
  - GraphQL `organization.packages(packageType:CONTAINER)` ist **nicht nutzbar** (live: `CONTAINER` ist kein gültiger `PackageType` im GraphQL-Schema; `DOCKER` liefert leere Liste mit App-Token).
- **Org:** fest = `Studis-Softwareschmiede` (Konstante, keine Nutzereingabe).
- **Setup-Vorbedingung (AC6, live-verifiziert 2026-06-18):**
  - Die Ursache des `400 Invalid argument` am Org-Listen-Endpunkt ist **kein Permission-Problem**: die GitHub-App `softwareschmiede-bot[bot]` hat nachweislich Packages-Lesezugriff (Einzel-Endpunkte liefern 200 mit demselben Token).
  - Das `400` ist eine **bekannte GitHub-API-Limitation** für App-Installation-Tokens am Org-Listen-Endpunkt — unabhängig von Permissions, nicht behebbar durch Permission-Nachzug.
  - **Keine „Packages: Read"-Permission muss nachgezogen werden** für den gewählten Lösungsweg (Variante c nutzt ausschließlich die bereits funktionierenden Endpunkte).
  - Voraussetzung: Die GitHub-App benötigt `Contents: Read` (für `/installation/repositories`) und Zugriff auf die Container-Packages der Org (bereits vorhanden, belegt durch 200 auf Einzel-Endpunkten).

## Edge-Cases & Fehlerverhalten
- Org-Listen-Endpunkt antwortet `400 "Invalid argument"` (heutiger Live-Befund) → der gewählte Lösungsweg umgeht/behebt das; **kein** stilles Verschlucken zur Leerliste, solange Pakete existieren + Token berechtigt (AC1).
- App-Token gültig, aber Permission fehlt (`401/403/400`) → degradiert zu leerer Liste + `errors` (AC4); die fehlende Permission ist als Setup-Vorbedingung dokumentiert (AC6), nicht als Dauerzustand akzeptiert.
- GraphQL-Variante: `errors`-Array in der GraphQL-Antwort → wie API-Fehler behandelt (Degradation, kein Leak).
- Einzel-Endpunkt-Variante: einzelne Pakete **404** → stilles Skip (kein Error-Eintrag; Repo hat einfach kein gleichnamiges Container-Image — erwarteter Normalfall); **5xx / 403 / Netzwerkfehler** → `errors[]`-Eintrag je gescheitertem Paket, übrige Pakete bleiben (AC3).
- Token nicht auflösbar (Provider `undefined`) → leere Liste, 200 (AC4).

## Bekannte Einschränkung (Variante c)
- **Annahme: Container-Package-Name == Repository-Name.** Die Probe-Strategie leitet den Package-Namen direkt aus dem Repo-Namen ab und ruft `GET /orgs/{org}/packages/container/{repo-name}` auf. Packages unter einem vom Repo-Namen abweichenden Namen sowie mehrere Container-Packages pro Repo werden von dieser Strategie **nicht entdeckt**. Im aktuellen Setup der Softwareschmiede trägt jedes Repo genau ein Container-Image mit identischem Namen (live-verifiziert 2026-06-18), sodass die Annahme zutrifft.

## NFRs
- **Sicherheit (Floor, hart):** read-only; App-Token-only ([[github-app-token-unification]] AC9, **kein** `GH_TOKEN`); App-Token nie geleakt (Response/Log/WS/Argv/Bundle); Org fix (kein SSRF); `{name}` (Tag-Pfad) bleibt validiert.
- **Resilienz:** jeder Fetch mit Timeout; degradiert auf leere/teil-Liste statt 5xx.
- **ADR-005/-007-Konformität:** kein Image-Store — Liste **live**; kein neues SDK (eingebautes `fetch` über den bestehenden Reader-Boundary; GraphQL ggf. über denselben `fetch`).

## Nicht-Ziele
- Änderungen am Tag-Pfad (`/{name}/tags`) oder am UI-Dropdown ([[deploy-lifecycle]] AC10) — beide bleiben unverändert.
- Aufweichen des App-Token-only-Floors (kein `GH_TOKEN`-Fallback).
- Image-Build/Push/Löschen in ghcr.

## Abhängigkeiten
- [[ghcr-image-list]] (Endpunkt-/Read-Model-Vertrag, S-154 — diese Spec repariert nur den Auflist-Pfad).
- [[github-app-token-unification]] (App-Token-Provider, S-146; App-Token-only, S-149 — Token-Quelle + Floor).
- [[github-repos-overview]] (Reader-Boundary-Muster + graceful degradation).
- [[deploy-lifecycle]] (Konsument: Image-Dropdown, AC10).
- `docs/architecture.md` — GitHub-Reader-Boundary, ADR-007 (App-Token).
