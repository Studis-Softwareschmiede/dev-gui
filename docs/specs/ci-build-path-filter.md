---
id: ci-build-path-filter
title: CI-Build-Path-Filter — kein Container-Build bei reinen Board-/Doku-Commits
status: active
area: deployment
version: 1
---

# Spec: CI-Build-Path-Filter  (`ci-build-path-filter`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Die CI-Pipeline (`.github/workflows/build.yml`) soll den vollen ~5-Minuten-Lauf (secret-scan + lint + test + Docker-Image) **nicht** mehr für Commits fahren, die ausschliesslich Board-State, Doku oder Markdown berühren. Im Einzel-Drain-Modus (`merge_policy: direct`) erzeugt jede Story mehrere reine YAML-Statuswechsel-Commits auf `main` (`chore(board)` In Progress/Done/dispo-mirror); jeder löst heute einen vollen Docker-Build aus, obwohl `board/**`, `docs/**` und `**.md` das Image nicht verändern. Das Streichen dieser Leerläufe ist die grösste einzelne CI-Einsparung, **ohne** dass eine echte Code-Änderung ungebaut/ungetestet nach `main` durchrutschen darf.

## Verhalten
1. **Board-/Doku-only-Commit → kein Build:** Ein Push auf `main`, dessen Commit(s) ausschliesslich Pfade unter `board/**`, `docs/**` und/oder Markdown (`**.md`, an beliebiger Stelle im Baum) berühren, startet **keinen** Lauf des `build`-Workflows (keiner der Jobs `secret-scan`, `lint`, `test`, `image` läuft).
2. **Code-Commit → voller Build:** Ein Push auf `main`, dessen Commit(s) mindestens eine Datei ausserhalb der ignorierten Pfade berührt (z. B. Produktivcode, Tests, `Dockerfile`, `package.json`/`package-lock.json`, CI-Config unter `.github/**`), startet den `build`-Workflow **vollständig und unverändert** (alle vier Jobs, bisherige `needs`-Reihenfolge).
3. **Gemischter Commit → voller Build:** Ein Push, dessen Änderungsmenge sowohl ignorierte (`board/**`/`docs/**`/`**.md`) als auch nicht-ignorierte Dateien enthält, startet den `build`-Workflow **vollständig** — sobald mindestens eine nicht-ignorierte Datei betroffen ist, wird gebaut.
4. **Kein stiller Code-Durchrutsch:** Es existiert **keine** Kombination von Pfaden, bei der eine Änderung an Produktivcode/Tests/`Dockerfile`/CI-Config/Dependency-Manifest auf `main` landet, **ohne** dass `secret-scan`, `lint`, `test` und `image` dafür laufen. Der Filter darf ausschliesslich rein-ignorierte Commits überspringen.
5. **Selbst-Dokumentation:** In `build.yml` steht ein Kommentar, der erklärt, warum die Pfad-Filter existieren (Einsparung von Leerläufen bei reinen Board-/Doku-Commits) und welche Pfade bewusst ignoriert werden.

## Acceptance-Kriterien
- **AC1** — Push auf `main` mit ausschliesslich `board/**`-Änderungen löst **keinen** `build`-Workflow-Lauf aus (auch nicht `secret-scan`).
- **AC2** — Push auf `main` mit ausschliesslich `docs/**`- und/oder `**.md`-Änderungen (Markdown an beliebiger Stelle) löst **keinen** `build`-Workflow-Lauf aus.
- **AC3** — Push auf `main`, der mindestens eine Datei ausserhalb von `board/**`, `docs/**`, `**.md` berührt (z. B. `src/**`, `test/**`, `Dockerfile`, `package.json`, `.github/workflows/**`), löst den `build`-Workflow **vollständig** aus (alle Jobs `secret-scan`, `lint`, `test`, `image`).
- **AC4** — Ein **gemischter** Push (ignorierte + nicht-ignorierte Pfade in derselben Änderungsmenge) löst den `build`-Workflow **vollständig** aus (Sicherheits-Nebenbedingung: gemischt ⇒ bauen).
- **AC5** — Es gibt **keinen** Pfad-Ausdruck im Filter, der eine echte Code-/Test-/Dockerfile-/CI-Config-/Dependency-Manifest-Änderung stillschweigend vom Build ausnimmt; der ignorierte Satz ist exakt `board/**`, `docs/**`, `**.md` (kein breiterer Glob wie `**` oder `*`).
- **AC6** — `build.yml` enthält einen erklärenden Kommentar zur Existenz und zum Zweck der Pfad-Filter (siehe Verhalten 5).
- **AC7** — Der `build`-Job-Graph und die Job-Inhalte (secret-scan/lint/test/image, `needs`-Kette, Image-Tags/build-args) bleiben inhaltlich unverändert; die Änderung betrifft ausschliesslich den `on: push`-Trigger bzw. einen vorgeschalteten Guard.

## Verträge
- **Betroffene Datei:** `.github/workflows/build.yml`.
- **Umsetzungsweg (offen, `coder` wählt):** entweder
  - **(a) `paths-ignore`** am `on: push`-Trigger:
    ```yaml
    on:
      push:
        branches: [main]
        paths-ignore:
          - 'board/**'
          - 'docs/**'
          - '**.md'
    ```
    GitHub startet den Workflow-Lauf, sobald mindestens eine geänderte Datei **nicht** von `paths-ignore` erfasst ist — erfüllt AC3/AC4 korrekt (gemischt ⇒ Build) und AC1/AC2 (rein ignoriert ⇒ kein Lauf); ODER
  - **(b) ein sauberer Guard-Job**, der die geänderte Dateimenge prüft und die Folge-Jobs nur bei mindestens einer nicht-ignorierten Datei freigibt (gleiche Semantik).
- **Trigger-Semantik (verbindlich, egal welcher Weg):** rein-ignoriert ⇒ kein Build; mind. eine nicht-ignorierte Datei ⇒ voller Build.

## Edge-Cases & Fehlerverhalten
- **Markdown ausserhalb `docs/`** (z. B. `README.md`, `CLAUDE.md` im Root, `foo/bar.md`): vom `**.md`-Glob erfasst ⇒ kein Build, sofern der Commit nur Markdown/Board berührt.
- **Nicht-Markdown-Doku ausserhalb `docs/`** (z. B. eine `.txt`/`.svg` im Root): **nicht** ignoriert ⇒ Build. Der Filter ignoriert bewusst nur `docs/**` (gesamter Doku-Ordner) und `**.md` (Markdown überall), nicht beliebige Nicht-Code-Dateien.
- **`.github/**`-Änderungen** (inkl. `build.yml` selbst): **nicht** ignoriert ⇒ Build (CI-Config ist baurelevant).
- **Dependency-Manifeste** (`package.json`, `package-lock.json`): nicht ignoriert ⇒ Build.
- **Merge-/Multi-Commit-Push:** GitHub bewertet die Gesamtheit der im Push geänderten Dateien; ist auch nur eine nicht-ignorierte Datei dabei, läuft der Build (deckt AC4 auf Push-Ebene ab).

## NFRs
- **Security (kein stiller Code-Durchrutsch):** AC4/AC5 sind die harte Sicherheits-Nebenbedingung — der Filter darf niemals eine Code-/Dependency-/CI-Änderung ungebaut/ungetestet nach `main` lassen. Bei Unsicherheit gilt „im Zweifel bauen".
- **Secret-Scan-Abdeckung für ignorierte Pfade:** Der per-Push-`secret-scan` in `build.yml` entfällt bei rein ignorierten Commits. Diese Lücke ist bewusst tolerierbar, weil `.github/workflows/security.yml` wöchentlich (und manuell) einen **tiefen History-Scan** (`fetch-depth: 0`, gesamte Git-Historie) über den kompletten Baum fährt — Secrets, die in `board/**`/`docs/**`/`**.md` eingecheckt würden, werden dort erkannt und als Board-Issue gemeldet. Der Path-Filter darf `security.yml` **nicht** verändern.
- **Durchsatz:** Ziel ist die Elimination der ~5-Min-Leerläufe pro reinem Board-/Doku-Commit im Einzel-Drain-Modus (mehrere pro Story).

## Nicht-Ziele
- Keine Änderung an Job-Inhalten, Tags, build-args oder der `needs`-Kette von `build.yml` (nur Trigger/Guard).
- Keine Änderung an `security.yml` (der wöchentliche Deep-Scan bleibt die Secret-Abdeckung für ignorierte Pfade).
- Keine Umstellung des `merge_policy` oder der Board-Commit-Frequenz — das ist eine andere Baustelle.
- Kein Pinnen der Actions auf SHA (separate Härtungs-Aufgabe, im Bestandskommentar bereits vermerkt).

## Abhängigkeiten
- `.github/workflows/build.yml` (Bestand), `.github/workflows/security.yml` (Bestand, liefert die Deep-Scan-Abdeckung — nur Referenz, nicht ändern).
