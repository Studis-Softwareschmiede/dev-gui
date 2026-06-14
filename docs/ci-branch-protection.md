# CI-Branch-Protection — Vorbereitung & Anleitung

> **Status: dokumentiert + vorbereitet, NICHT live gesetzt.**
> Das Live-Setzen ist ein bewusster Betreiber-Schritt (siehe Abschnitt "Voraussetzungen").

Dieses Dokument beschreibt, wie die Branch-Protection fuer `main` mit required Status-Checks
aktiviert wird, sobald die Voraussetzungen erfuellt sind (AC18, Schicht 3 aus
`docs/architecture/parallel-agent-workflow.md`).

---

## 1. Required-Check-Namen

Die drei Checks, die als required gesetzt werden muessen, entsprechen den Job-Namen in
`.github/workflows/build.yml`:

| Check-Name    | Job-Quelle            | Zweck                                      |
|---------------|-----------------------|--------------------------------------------|
| `secret-scan` | `jobs.secret-scan`    | gitleaks — kein Secret im Commit           |
| `lint`        | `jobs.lint`           | ESLint — kein Lint-Fehler                  |
| `test`        | `jobs.test`           | npm test — alle Unit-Tests gruen           |

Der `image`-Job ist kein required Check (er haengt via `needs` von den drei obigen ab und
wird dadurch implizit blockiert).

### Wichtig: GitHub-Check-Namen sind format-abhaengig

GitHub zeigt Required-Status-Checks entweder als **kurzen Job-Namen** (`lint`) oder als
**`<workflow-name> / <job-id>`** (`build / lint`) an — je nach GitHub-Version und Setup.
Das falsche Format macht die Branch-Protection wirkungslos ODER blockiert alle Merges dauerhaft.

**Verbindlicher Schritt vor dem `gh api`-Aufruf (Abschnitt 2):**

> Ermittle die EXAKTEN Check-Namen aus einem realen PR- oder Push-Lauf:
> GitHub → Repository → Actions-Tab → den entsprechenden Workflow-Lauf anklicken →
> im Checks-Tab der PR-Ansicht die Spalte **Check name** ablesen.
> Setze die `contexts`-Strings im `gh api`-Befehl GENAU auf diese abgelesenen Werte.

Moegliche Formate (eines davon wird GitHub anzeigen):
- Kurz: `"secret-scan"`, `"lint"`, `"test"`
- Lang:  `"build / secret-scan"`, `"build / lint"`, `"build / test"`

---

## 2. gh-API-Befehl zum Setzen der Branch-Protection

```bash
gh api \
  --method PUT \
  repos/{owner}/{repo}/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["<EXAKTER-CHECK-NAME-1>", "<EXAKTER-CHECK-NAME-2>", "<EXAKTER-CHECK-NAME-3>"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

Konkret fuer dieses Repo (Platzhalter mit real abgelesenen Check-Namen ersetzen — siehe Abschnitt 1):

```bash
gh api \
  --method PUT \
  repos/Studis-Softwareschmiede/dev-gui/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["<EXAKTER-CHECK-NAME>", "<EXAKTER-CHECK-NAME>", "<EXAKTER-CHECK-NAME>"]
    // Ersetze die Platzhalter mit den EXAKTEN Namen aus dem GitHub-Checks-Tab
    // Moegliche Beispiele: ["secret-scan","lint","test"] ODER ["build / secret-scan","build / lint","build / test"]
    // Welches Format gilt, siehst du im Actions/Checks-Tab eines realen PR-Laufs (Abschnitt 1).
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

**Hinweis:** `strict: true` erzwingt, dass der Branch vor dem Merge auf dem aktuellen Stand
von `main` ist (verhindert veraltete Merges).

---

## 3. Voraussetzung: pull_request-Trigger + image-if-Guard

**Kritischer Punkt:** Required-Status-Checks greifen auf **PR-Ebene** — GitHub prueft, ob
die Checks fuer den Head-Commit des PR gruen sind. Damit das funktioniert, muss der Workflow
**auch** auf `pull_request`-Events laufen (nicht nur auf `push`).

**Aktueller Stand:** `build.yml` triggert nur auf `push: branches: [main]`. Das bedeutet:
- Auf `main`-Pushes laufen die Jobs — aber das ist nach dem Merge, zu spaet.
- Auf PRs laufen die Jobs **nicht** — required-checks wuerden jeden Merge blockieren,
  weil die Checks nie ausgefuehrt werden und damit nie "gruen" werden koennen.

### Fertiges YAML-Snippet fuer den pull_request-Trigger-Umbau

```yaml
name: build
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
permissions:
  contents: read
  packages: write
jobs:
  secret-scan:
    # ... unveraendert ...

  lint:
    # ... unveraendert ...

  test:
    # ... unveraendert ...

  image:
    needs: [secret-scan, lint, test]
    # Nur auf push-Events bauen/pushen — nicht auf pull_request-Events
    # (pull_request-Events koennen technisch ebenfalls auf refs/heads/main laufen)
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    # ... Rest unveraendert ...
```

Die entscheidenden Aenderungen:
1. `on:` bekommt `pull_request: branches: [main]` — damit laufen secret-scan, lint, test
   auch auf PRs und koennen als required checks greifen.
2. `image:` bekommt `if: github.event_name == 'push'` — damit wird das Image nur bei
   direkten Pushes gebaut/gepusht, nicht bei pull_request-Events (semantisch klarer als
   `github.ref == 'refs/heads/main'`, da pull_request-Events technisch ebenfalls auf
   `refs/heads/main` laufen koennen).

---

## 4. Live-Aktivierung — bewusster Betreiber-Schritt (Koordination erforderlich)

**Warum jetzt nicht live gesetzt:**

Der `pull_request`-Trigger-Umbau und das Setzen der Branch-Protection greifen in den
laufenden parallelen Agenten-Merge-Flow ein:

- Sobald required-checks aktiv sind, koennen keine Merges mehr ohne gruene Checks landen.
- Waehrend laufende parallele Agenten-Sessions PRs offen haben, wuerden diese erst nach
  einem erfolgreichen Check-Lauf mergebar — was eine Koordination erfordert.
- Der Umbau selbst (pull_request-Trigger) ist ein Edit an `build.yml`, das Konflikte mit
  laufenden Sessions verursachen kann, die ebenfalls `build.yml` anfassen.

**Schritt-fuer-Schritt zum Live-Aktivieren (wenn kein paralleler Agent aktiv ist):**

1. Alle offenen PRs mergen oder schliessen.
2. `build.yml` wie im YAML-Snippet oben umbauen (pull_request-Trigger + image-if-Guard).
3. Den Umbau committen + nach `main` pushen (oder via PR, dann merged er ohne
   required-checks, weil die noch nicht aktiv sind).
4. Mindestens einen PR-Lauf abwarten, damit GitHub die Check-Namen kennt (sonst findet
   die Branch-Protection die Checks nicht in der Auswahl).
4a. **VERBINDLICH — EXAKTE Check-Namen ablesen:** GitHub → Repository → den PR-Lauf
    anklicken → Checks-Tab → Spalte **Check name** ablesen. Die angezeigten Namen
    (`lint` oder `build / lint` — je nach GitHub-Format) EXAKT in die `contexts`-Liste
    im `gh api`-Befehl uebertragen. Falsche Namen machen die Protection wirkungslos
    oder blockieren alle Merges dauerhaft (siehe Abschnitt 1).
5. Den `gh api`-Befehl aus Abschnitt 2 ausfuehren (mit real abgelesenen Check-Namen).
6. Verifizieren: `gh api repos/Studis-Softwareschmiede/dev-gui/branches/main/protection`

---

## 5. Zusammenfassung des aktuellen CI-Absicherungs-Stands

```
push → main
        ├── secret-scan  (gitleaks)           ─┐
        ├── lint         (eslint)              ─┼─ Gates: alle drei muessen gruen sein
        └── test         (npm test)            ─┘
                                                 ↓ (needs: [secret-scan, lint, test])
                                              image  (Docker-Build + Push nach ghcr.io)
```

- Roter Test → `image` wird nicht gebaut/gepusht (needs-Kette).
- Branch-Protection (required-checks) → Merge blockiert bei rotem Check (nach Live-Aktivierung).
- Kein Anthropic-API, kein `claude -p`, keine Klartext-Secrets im `test`-Job (AC19).
- Sonar/teure Scans laufen weiterhin auf separatem, oekonomischem Cadence (monatlich/manuell),
  nicht im per-Push-Gate.
