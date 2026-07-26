> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-096 (target:local-Regressionslauf end-to-end lauffähig) ist in Arbeit im
Feature-Batch: S-415 (Test-Deps + Browser-Guard), S-416 (Port-Auflösung +
Ziel-Adressierung) und S-419 (Verbund-Scope ohne id) sind auf feature/F-096
gelandet. Als Nächstes: S-417 (App-Secrets via Bitwarden/GPG in die
Kind-Env), danach S-418 (Integrationslauf, depends auf S-417). Feature
landet gebündelt am Ende in main (kein Rollout je Story).

## Letzte Arbeiten
- S-419 / Verbund-Scope ohne id (AC13 regression-run): validateScope
  akzeptiert { typ: "verbund" } ohne id (eigener Zweig vor der generischen
  id-Pflicht), id tolerant/wirkungslos; bereich verlangt weiter id.
  „Verbund ausführen" liefert kein 400 missing-id mehr. EP 3/3.
- S-416 / Port + Ziel-Adressierung (AC4-AC6 regression-local-execution):
  portFieldRegex() toleriert Inline-Kommentare (beide Port-Leser);
  port=null → precondition-error „lokaler Test-Port nicht bestimmbar";
  #resolveTargetAddress() host.docker.internal:<hostPort> (Container,
  echtes Mapping via LocalDockerControl#getMappedHostPort) vs.
  127.0.0.1:<port> (Host) — eine Adresse für Probe + REGRESSION_BASE_URL.
  docker-compose.yml: extra_hosts host-gateway. EP 4/7 (unterschätzt).
- S-415 / Test-Deps + Browser-Guard (AC1-AC3): ensureTestDependencies +
  checkBrowserVersionGuard in #runLifecycle, nur target:local, VOR
  Port-Prüfung; feste secret-freie Diagnosen. Tests via Factory
  newRegressionRunner(). EP 4/4.
- S-409 / bw config konditional (AC17-AC21): config nur bei unauthenticated
  oder abweichender Server-URL; Fehlerklasse config-failed. EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.
- S-404 / Verlauf-Aufklapper: RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste: Sammel-Button + Rückfrage. EP 7 vs. 4.

## Offene Fäden
- ADR-Eintrag zu A1 (Playwright-Browser fest im Image + zentrales
  Versions-Pinning) in docs/architecture.md vor F-096-Abschluss nachziehen
  (Reviewer-Suggestion S-415; auch in board/runs/F-096/notes.md notiert).
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht (generischer Fallback-Text) — Folge-Ticket sinnvoll.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree; positionale Jest-Argumente
  filtern nicht — --testPathPatterns nutzen (S-416-Erkenntnis).
