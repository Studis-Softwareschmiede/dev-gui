> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-096 (target:local-Regressionslauf end-to-end lauffähig) ist in Arbeit im
Feature-Batch: S-415 (Test-Deps + Browser-Versions-Guard) ist auf
feature/F-096 gelandet — der Runner stellt jetzt vor dem Playwright-Start
seine Vorbedingungen her statt blind zu starten. Als Nächstes: S-416
(Port-Auflösung robust/Inline-Kommentare), S-417 (App-Secrets via
Bitwarden/GPG in die Kind-Env), S-419 (Scope-Vertrag Reader↔Runner),
danach S-418 (Integrationslauf, depends auf 415–417). Feature landet
gebündelt am Ende in main (kein Rollout je Story).

## Letzte Arbeiten
- S-415 / Test-Deps + Browser-Guard (AC1-AC3 regression-local-execution):
  ensureTestDependencies (npm ci/Fallback install) + checkBrowserVersionGuard
  (exakter Versions-Vergleich Klon vs. Image) in #runLifecycle, nur
  target:local, VOR Port-Prüfung; feste secret-freie Diagnosen. Tests via
  Factory newRegressionRunner() (Prechecks default bestehbar). EP 4/4.
- S-409 / bw config konditional (AC17-AC21): #openSession ruft config nur
  bei unauthenticated oder abweichender Server-URL; Fehlerklasse
  config-failed. server_url wird NICHT auto-befüllt. EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper: RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste: Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag: idempotent. EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel: RedTeamScanPanel.jsx. EP 7/5.25.

## Offene Fäden
- ADR-Eintrag zu A1 (Playwright-Browser fest im Image + zentrales
  Versions-Pinning) in docs/architecture.md vor F-096-Abschluss nachziehen
  (Reviewer-Suggestion S-415; auch in board/runs/F-096/notes.md notiert).
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht (generischer Fallback-Text) — Folge-Ticket sinnvoll.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400).
