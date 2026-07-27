> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-052 (VPS-SSH-Terminal) läuft als Feature-Batch: S-425 (Host-Key-
Stabilität über Rebuilds) ist in feature/F-052 gelandet — vor dem
Feature-Merge nach main steht noch die Live-Verifikation gegen echte
Provider-Infra aus (Owner-Schritt, in der Spec dokumentiert).
F-072 (Deploy-Bitwarden) ist komplett (S-414 Done), Feature-Merge
ausstehend. F-095 (Red-Team-Report) und F-050 (Obsidian-Ingest) sind
fachlich komplett; F-097 ist auf main und ausgerollt.

## Vom parallelen main-Stand übernommen (Merge 2026-07-27)
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
- S-425 / Host-Key-Persistenz (Variante a): Ed25519-Keypaar je
  VPS-Ziel-Name, verschlüsselt im CredentialStore, via cloud-init
  `ssh_keys:` eingebettet (CloudInitBuilder v6); MITM-Schutz
  unverändert. EP 6.5/5.0, 2 Iterationen.
- S-414 / config-failed-Meldung im Validate-Katalog (AC22). F-072 damit
  komplett.
- S-386 / Done-Nachtrag: Fix (persistentes bw-Appdata-Verzeichnis) war
  als PR #431 längst auf main + deployt; nur Board-Status nachgezogen.
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`.
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks`
  über den Detail-Endpunkt nach.

## Offene Fäden
- ⚠ F-052 Merge-Vorbehalt: Live-Verifikation (realer delete()+create()-
  Rebuild-Zyklus + SSH-Connect) vor Feature-Merge nach main — Anleitung
  in docs/specs/vps-host-key-stabilitaet.md.
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer. Owner-
  Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- Landen aus Worktree: Modus B (`--target-branch`) läuft (flow/L09);
  Modus A weiter von Hand (flow/L07, Retro-Issue #371 offen).
- Testläufe im Worktree: npm run test:worktree (S-400).
