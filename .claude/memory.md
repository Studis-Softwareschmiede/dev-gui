> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-096 (target:local-Regressionslauf end-to-end lauffähig) ist fast durch:
S-415 (Test-Deps + Browser-Guard), S-416 (Port + Ziel-Adressierung), S-419
(Verbund-Scope ohne id) und S-417 (App-Secrets in die Kind-Env) sind auf
feature/F-096 gelandet. Es fehlt nur noch S-418 (Integrationslauf, depends
auf S-417 — jetzt frei). Feature landet gebündelt am Ende in main (kein
Rollout je Story).

## Letzte Arbeiten
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8 regression-local-
  execution): resolveLocalRegressionSecrets — GPG-Passphrase via geteilte
  BitwardenDeployLoginService-Instanz (Item env.gpg-passphrase-<projekt>),
  .env.gpg via gpg -d (Passphrase nur über stdin), Secrets ausschließlich
  in die Playwright-Kind-Env, nur target:local. A2: fehlendes Secret →
  kontrollierter Skip, nie stiller secret-loser Lauf. Security-Floor
  testbelegt (nie argv/Job-Status/Audit/Platte). EP 4/5.25.
- S-419 / Verbund-Scope ohne id (AC13 regression-run): validateScope
  akzeptiert { typ: "verbund" } ohne id; bereich verlangt weiter id. EP 3/3.
- S-416 / Port + Ziel-Adressierung (AC4-AC6): portFieldRegex() toleriert
  Inline-Kommentare; port=null → precondition-error; #resolveTargetAddress()
  host.docker.internal:<hostPort> (Container) vs. 127.0.0.1:<port> (Host);
  extra_hosts host-gateway in docker-compose.yml. EP 4/7 (unterschätzt).
- S-415 / Test-Deps + Browser-Guard (AC1-AC3): ensureTestDependencies +
  checkBrowserVersionGuard in #runLifecycle, nur target:local; Tests via
  Factory newRegressionRunner(). EP 4/4.
- S-409 / bw config konditional (AC17-AC21): config nur bei unauthenticated
  oder abweichender Server-URL; Fehlerklasse config-failed. EP 6.5/5.25.
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt. EP 4/4.

## Offene Fäden
- ADR-Eintrag zu A1 (Playwright-Browser fest im Image + zentrales
  Versions-Pinning) in docs/architecture.md vor F-096-Abschluss nachziehen
  (Reviewer-Suggestion S-415; auch in board/runs/F-096/notes.md notiert).
- Spec regression-local-execution §Verträge: „Bitwarden-Item je Secret-
  Name" ist ein Authoring-Slip — Implementierung folgt bewusst der
  per-App-.env.gpg-Doktrin; Formulierung nachziehen (Reviewer S-417).
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht (generischer Fallback-Text) — Folge-Ticket sinnvoll.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree; positionale Jest-Argumente
  filtern nicht — --testPathPatterns nutzen (S-416-Erkenntnis).
