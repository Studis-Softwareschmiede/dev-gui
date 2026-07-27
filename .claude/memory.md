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

## Vom parallelen main-Stand übernommen (Merge 2026-07-27)
F-072 (Deploy-Bitwarden) wird als Feature-Batch abgearbeitet: S-386 ist
jetzt Done (Nachtrag — Fix war seit 2026-07-19 gelandet + deployt);
verbleibt S-414 (AC22, config-failed-Meldung im Validate-Katalog), dann
Feature-Merge. F-095 (Red-Team-Report) und F-050 (Obsidian-Ingest) sind
fachlich komplett; F-096 (Regression target:local) läuft parallel als
Feature-Batch; F-097 ist auf main und ausgerollt.
Wichtig (F-095): das reale red-team-End-JSON liefert nur einen
Fund-Zähler, daher liefert der Parser heute immer `auswertbar:false` —
der Store bleibt leer (ehrliche Degradation), bis der red-team-Skill
strukturierte Arrays liefert.

## Letzte Arbeiten
- S-386 / Done-Nachtrag: Fix (persistentes bw-Appdata-Verzeichnis,
  `login --check`, `lock` statt `logout`) war als PR #431 längst auf
  main + deployt; Session hat nur den Board-Status nachgezogen. Keine
  Metrik (keine Dispatches — Arbeit lief am 2026-07-19 extern).
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`,
  sichtbar bei starting/running, weg bei done/Fehler. EP 3/3.
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks`
  über den Detail-Endpunkt nach; Ampel-Konstanten geteilt. EP 4/4.
- S-411 / record()-Naht + checks (AC26–AC28): Poll persistiert bei done
  genau einmal (nur `auswertbar:true`). EP 4/4.
- S-410 / Parser + Exposition (AC24/AC25): `src/redTeamOutputParser.js`
  (fail-safe); `HeadlessRunnerCore` opt-in `captureOutput`. EP 4/4.
- S-391 / Headless-Format-Signal (AC20-AC22): `HEADLESS_GUI_TOKEN` +
  `JSON_OUTPUT_INSTRUCTION` in defaultRunClaude. EP 3/4.

## Offene Fäden
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer (nie
  falsches Grün). Owner-Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- VALIDATE_ERROR_MESSAGES kennt config-failed nicht — S-414 auf dem
  Board (nächste F-072-Story, READY).
- Landen aus Worktree: Modus B (`--target-branch`) läuft (flow/L09);
  Modus A weiter von Hand (flow/L07, Retro-Issue #371 offen).
- Testläufe im Worktree: npm run test:worktree (S-400).
