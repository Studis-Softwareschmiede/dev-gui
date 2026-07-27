> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-096 (target:local-Regressionslauf end-to-end lauffähig) ist mit S-418
vollständig: alle 5 Stories (S-415, S-416, S-419, S-417, S-418) liegen auf
feature/F-096. Nächster Schritt ist der gebündelte Feature-Merge in main
(board-ship.sh --merge-feature via board-feature-drain.sh) — vorher den
ADR-Eintrag zu A1 in docs/architecture.md nachziehen (s. Offene Fäden).
Der echte AC11-Live-Lauf (flashrescue-Verbund aus der Oberfläche) steht
als Owner-/Betriebs-Verifikation noch aus.

## Letzte Arbeiten
- S-418 / REAL_SEND-Gate + Test-Config-Leitkanal (AC9/AC10 regression-
  local-execution): REAL_SEND_GATE_ENV_VARS-Hard-Strip in
  defaultRunPlaywright (FLASHRESCUE_REGRESSION_ALLOW_REAL_SEND aus
  process.env UND secretEnv entfernt, vor spawn); AC9 bewusst ohne
  Eigenbau — voller Env-Durchgriff als Leitkanal für suite-eigene
  Provisionierung (flashrescue setFeeViaSettings via
  FLASHRESCUE_CONFIG_DIR). AC11 nicht live verifiziert. EP 3/4.
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8): resolveLocal-
  RegressionSecrets — .env.gpg via gpg -d (Passphrase nur stdin), Secrets
  nur in die Playwright-Kind-Env; fehlendes Secret → kontrollierter Skip.
  Security-Floor testbelegt. EP 4/5.25.
- S-419 / Verbund-Scope ohne id (AC13 regression-run): validateScope
  akzeptiert { typ: "verbund" } ohne id. EP 3/3.
- S-416 / Port + Ziel-Adressierung (AC4-AC6): port=null → precondition-
  error; #resolveTargetAddress() host.docker.internal:<hostPort>
  (Container) vs. 127.0.0.1:<port> (Host). EP 4/7.
- S-415 / Test-Deps + Browser-Guard (AC1-AC3): ensureTestDependencies +
  checkBrowserVersionGuard in #runLifecycle; Tests via Factory
  newRegressionRunner(). EP 4/4.

## Offene Fäden
- Vor dem F-096-Merge in main: ADR-Eintrag zu A1 (Playwright-Browser fest
  im Image + zentrales Versions-Pinning) in docs/architecture.md
  (Reviewer-Suggestion S-415).
- AC11-Live-Verifikation: lokaler flashrescue-Container braucht einen
  -v <host>:/app/config-Mount, damit setFeeViaSettings() greift —
  Deployment-Voraussetzung, kein dev-gui-Code (S-418-Befund).
- Spec regression-local-execution §Verträge: „Bitwarden-Item je Secret-
  Name" ist ein Authoring-Slip — Implementierung folgt der per-App-
  .env.gpg-Doktrin; Formulierung nachziehen (Reviewer S-417).
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die Klasse
  config-failed nicht (generischer Fallback) — Folge-Ticket sinnvoll.
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
