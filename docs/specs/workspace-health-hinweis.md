---
id: workspace-health-hinweis
title: Workspace-Health — Deploy-Diagnose & Hinweis bei Fehlkonfiguration
status: active
area: deployment
version: 1
---

# Spec: Workspace-Health  (`workspace-health-hinweis`)

> **Zweck.** Beim Deploy (insbesondere auf dem **VPS**) wird leicht vergessen, den
> Workspace-Mount + `BOARD_ROOTS` korrekt zu setzen — das Ergebnis ist ein **leeres
> Board / leere Fabrik-Übersicht ohne erkennbaren Grund**. dev-gui soll diese
> Fehlkonfiguration **selbst diagnostizieren** und sie (a) in den Einstellungen
> sichtbar machen und (b) beim Start ins Log schreiben. Read-only Diagnose, kein
> Crash.
>
> Hintergrund: Mount-Architektur ist zweistufig (`mountRoot` = Host→Container-Mount
> via `.env`/Compose pro Maschine; `effectivePath` = aktive Wurzel darin). Die
> `docker-compose.override.yml` ist gitignored + nur Dev → auf dem VPS gilt sie
> NICHT, weshalb dort `BOARD_ROOTS` separat gesetzt werden muss. Siehe
> [[workspace-path-config]].

## Verhalten / Designentscheidungen

- **Datenquelle = vorhandene Bausteine, read-only.** Kein neuer Speicher. Geprüft
  wird der Laufzeit-Zustand: Mount-Verzeichnis (FS), `BOARD_ROOTS` (env), gefundene
  Git-Repos (WorkspaceScanner) und Board-Projekte (BoardAggregator).
- **Drei Schweregrade je Check:** `ok` (grün), `warn` (gelb — funktioniert, aber
  vermutlich nicht gewollt), `error` (rot — mit hoher Wahrscheinlichkeit
  Fehlkonfiguration). Jeder nicht-`ok`-Check trägt eine **Klartext-Meldung + einen
  konkreten Fix-Hinweis**.
- **WO — Einstellungen** (bestehende `WorkspacePathSection` in `SettingsView`), direkt
  beim Workspace-Pfad. Zusätzlich **eine einmalige Start-Log-Zeile** beim
  Server-Boot, damit man die Fehlkonfiguration auch via `docker logs` sieht (genau
  der VPS-Deploy-Fall).
- **Kein Secret im Output.** Pfade sind kein Geheimnis (Klartext erlaubt, analog
  workspace-path-config AC6).

## Verhalten im Detail

### V1 — Health-Checks (Backend)
Ein read-only Aggregat liefert je Check `{ key, status: 'ok'|'warn'|'error', message, fix? }`:
- **mount-exists** — `WORKSPACE_DIR` (Mount-Ziel) existiert, ist Verzeichnis, lesbar. Fehlt → `error`.
- **mount-nonempty** — Mount enthält mindestens einen Eintrag. Leer → `error` (typisch: Host-Pfad nicht/falsch gemountet).
- **board-roots-set** — `BOARD_ROOTS` ist gesetzt und nicht leer. Ungesetzt → `error` mit Fix „auf dem VPS in docker-compose.yml/.env `BOARD_ROOTS=/workspace` setzen (override.yml gilt dort nicht)".
- **board-roots-valid** — jeder in `BOARD_ROOTS` genannte Pfad existiert + ist Verzeichnis. Sonst → `error`.
- **repos-found** — Anzahl gefundener Git-Repos (WorkspaceScanner). 0 → `warn`.
- **board-projects-found** — Anzahl gefundener Board-Projekte (Repos mit `board/`-Ordner). 0 → `warn`.

Gesamt-Status = höchste Schwere der Einzelchecks (`error` > `warn` > `ok`). Fehler beim Prüfen selbst → der betroffene Check wird `warn` mit Hinweis, **kein Crash**.

### V2 — API (read-only, hinter AccessGuard)
`GET /api/settings/workspace-health` → `{ overall: 'ok'|'warn'|'error', checks: [...], counts: { repos, boardProjects } }`. Read-only, kein zusätzlicher Rollencheck (analog GET workspace-path).

### V3 — Anzeige in den Einstellungen
In der `WorkspacePathSection` ein **Status-Block**: bei `overall=ok` ein dezenter grüner Hinweis („Workspace korrekt konfiguriert — N Repos, M Board-Projekte"); bei `warn`/`error` ein deutlich hervorgehobener Block (`role="alert"` bei error) mit je Meldung + Fix-Hinweis. Touch-Targets/Kontrast a11y-konform.

### V4 — Start-Log-Warnung
Beim Server-Start wird der Health-Status einmalig ausgewertet; bei `overall != ok` eine kompakte Warnzeile pro nicht-`ok`-Check ins Log (`console.warn`), inkl. Fix-Hinweis. Kein Secret. Bei `ok` keine Ausgabe (oder eine knappe Info-Zeile). Blockiert den Start nie.

### V5 — Schreibfehler → umsetzbare Setup-Anleitung (kopierbar)
Schlägt ein **Schreibzugriff in den Workspace** fehl (Repo klonen/anlegen/schreiben via `WorkspaceMutator`/`GitHubCloner`), weil der Ziel-Ordner **nicht bereitsteht** — er fehlt (`ENOENT`), ist nicht schreibbar (`EACCES`/`EPERM`/`EROFS`) oder gehört nicht dem Container-User (uid 1000) — liefert die API statt eines nackten Fehlers eine **strukturierte, umsetzbare Antwort**:
```
{ error: <Klartext>, setup: { message, hostPath, commands: [string, …] } }
```
- `commands` sind die **Host-Befehle**, die den Ordner bereitstellen, fertig zum Kopieren-und-Ausführen:
  ```
  sudo mkdir -p <hostPath>
  sudo chown -R 1000:1000 <hostPath>     # Container-User node = uid 1000
  ```
- `hostPath` = der **Host-Workspace-Pfad** (nicht der Container-Pfad `/workspace`), damit der Befehl auf der Maschine passt. Dazu wird `WORKSPACE_HOST_DIR` rein **informativ** als Container-Env durchgereicht (Compose); fehlt sie, zeigt die Anleitung einen erkennbaren Platzhalter (`<dein-host-workspace-pfad>`) + Erklärung.
- Das Frontend rendert `setup.commands` in einem **monospaced Code-Fenster mit „Kopieren"-Knopf** (ganzer Block in einem Rutsch kopierbar), darüber `setup.message` als Erklärung. Greift überall, wo ein Workspace-Schreibversuch fehlschlägt (z.B. Repo-Klonen im Cockpit).
- Gilt für lokal **und** VPS; der `hostPath` macht den Unterschied automatisch.

## Acceptance-Kriterien
- **AC1** — Backend liefert die Health-Checks aus V1 (mount-exists/-nonempty, board-roots-set/-valid, repos-found, board-projects-found) je mit status+message+fix; Gesamt-Status = höchste Schwere; Prüffehler → `warn`, kein Crash. *(V1)*
- **AC2** — `GET /api/settings/workspace-health` liefert `{ overall, checks, counts }` read-only hinter AccessGuard; kein Secret im Output. *(V2)*
- **AC3** — Die Einstellungen zeigen den Status sichtbar: grün bei ok, hervorgehobene Warnung/Fehler (mit Fix-Hinweis, `role=alert` bei error) sonst; a11y-konform. *(V3)*
- **AC4** — Beim Server-Start wird bei Fehlkonfiguration je nicht-ok-Check eine Warnzeile (mit Fix) geloggt; bei ok keine Warnung; nie Start-Abbruch. *(V4)*
- **AC5** — Ein fehlgeschlagener Workspace-Schreibzugriff (Ordner fehlt/nicht schreibbar/falscher Owner) liefert eine `setup`-Struktur mit `hostPath` + kopierbaren Host-Befehlen (`mkdir -p` + `chown 1000:1000`); das Frontend zeigt sie als monospaced Code-Block mit „Kopieren"-Knopf + Erklärung. Funktioniert lokal und auf dem VPS (hostPath aus `WORKSPACE_HOST_DIR`, Platzhalter wenn ungesetzt). *(V5)*

## Nicht-Ziele
- Automatisches Reparieren/Setzen des Mounts (Mount ist Ops/Compose-Sache, nicht zur Laufzeit änderbar) — die Anleitung ist bewusst manuell auszuführen.
- Health-Checks für andere Subsysteme (nur Workspace/Board-Sichtbarkeit).

## Abhängigkeiten
- Backend: `src/workspacePathRouter.js` (erweitern), `src/WorkspaceScanner.js`, `src/BoardAggregator.js`, `src/WorkspaceMutator.js` + `src/GitHubCloner.js` (Schreibfehler → `setup`-Struktur), `server.js` (Start-Log + Wiring).
- Frontend: `client/src/SettingsView.jsx` (`WorkspacePathSection`) + die Stelle(n), die Workspace-Schreibfehler anzeigen (kopierbarer Code-Block).
- Ops: `docker-compose.yml` reicht `WORKSPACE_HOST_DIR` rein informativ als Container-Env durch (für `hostPath` in der Setup-Anleitung).
- Baut auf [[workspace-path-config]] (mountRoot/effectivePath, WORKSPACE_DIR, BOARD_ROOTS) auf.
