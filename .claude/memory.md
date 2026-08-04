> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-094 (Red-Team hinter Access-Wall) neu blockiert: S-407 ist dev-gui-seitig
fertig (CredentialStore, Header-Durchreichung, UI, Tests sauber), aber eine
Cross-Repo-Lücke verhindert die Landung — der agent-flow-Red-Team-Skill kennt
das neue CF-Access-Header-Protokoll nicht, der Scan bleibt real vor der
Access-Wall stecken. Owner-Entscheid nötig.
F-052: S-425 in feature/F-052 gelandet, Live-Verifikation vor Merge offen.
F-072: komplett (S-414 Done), Feature-Merge nach main aussteht.
F-095 (Red-Team-Report) und F-050 (Obsidian-Ingest) fachlich komplett.
F-096: S-418 komplett, Feature-Merge aussteht (ADR-Eintrag vorher nachziehen).
F-097: auf main, ausgerollt.

## Letzte Arbeiten
- S-407 / Review Iteration 1 (Blocked): dev-gui-Verdrahtung (CredentialStore,
  Header-Durchreichung, UI) sauber gebaut, aber agent-flow/skills/red-team +
  agents/red-team.md konsumieren das CF-Access-Header-Protokoll nicht — Scan
  hinter der Wall aktuell wirkungslos. Story Blocked, Owner muss entscheiden:
  Cross-Repo-Fix in agent-flow vs. AC2-Scope-Reduktion.
- S-425 / Host-Key-Persistenz (Variante a): Ed25519-Keypaar je VPS-Ziel,
  verschlüsselt im CredentialStore, via cloud-init ssh_keys eingebettet. EP
  6.5/5.0, 2 Iterationen.
- S-414 / config-failed-Meldung im Validate-Katalog (AC22). F-072 damit
  komplett.
- S-386 / Done-Nachtrag: Fix war seit 2026-07-19 auf main + deployt, nur
  Board-Status nachgezogen.
- S-418 / REAL_SEND-Gate + Test-Config-Leitkanal (AC9/AC10). F-096 damit
  komplett. AC11 (Live-Lauf) nicht verifiziert.
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8): .env.gpg via gpg -d,
  Secrets nur in Playwright-Kind-Env.
- S-419 / Verbund-Scope ohne id (AC13 regression-run).
- S-416 / Port + Ziel-Adressierung (AC4-AC6).
- S-415 / Test-Deps + Browser-Guard (AC1-AC3).
- S-413 / Overlay-Text (AC31, RedTeamScanPanel.jsx).

## Offene Fäden
- F-094/S-407: Owner-Entscheid — agent-flow SKILL.md/agents/red-team.md um
  CF-Access-Header-Konsum erweitern (Cross-Repo-Story) oder AC2 auf
  "dev-gui bereitet vor, Konsum folgt in Folge-Story" reduzieren.
- F-052 Merge-Vorbehalt: Live-Verifikation (delete()+create()-Rebuild +
  SSH-Connect) vor Feature-Merge nach main.
- F-095-Kernrisiko: red-team-End-JSON ohne findings/checks-Array — Store
  bleibt leer bis agent-flow strukturierte Arrays liefert. Owner offen.
- F-096: ADR-Eintrag zu A1 (Playwright-Browser-Pinning) vor Feature-Merge
  nachziehen.
- Landen aus Worktree: Modus B (--target-branch) läuft (flow/L09); Modus A
  weiter von Hand (flow/L07, Retro-Issue #371 offen).
F-069 (Run-State-Live-Anzeige) ist mit S-385 komplett (9/9) — der
Feature-Merge nach main steht aus (board-feature-drain.sh
--merge-feature). F-096 (target:local-Regressionslauf) ist mit allen 5
Stories auf feature/F-096 komplett, Feature-Merge ebenfalls ausstehend
(vorher ADR-Eintrag zu A1 nachziehen, s. Offene Fäden). F-052
(VPS-SSH-Terminal): S-425 in feature/F-052 gelandet, vor dem Merge
Live-Verifikation gegen echte Provider-Infra nötig (Owner-Schritt).
F-072 (Deploy-Bitwarden) komplett, Feature-Merge ausstehend. F-095
(Red-Team-Report) und F-050 (Obsidian-Ingest) fachlich komplett; F-097
auf main und ausgerollt.

## Letzte Arbeiten
- S-385 / Done-Nachtrag (F-069 damit 9/9): RunStateReader-ENOENT-Fix
  (AC3) war seit 2026-07-19 als PR #430 gemergt + deployt; nur der
  Board-Status blieb offen. Kein neuer Code, keine Metrik-Zeile.
- S-425 / Host-Key-Persistenz (Variante a): Ed25519-Keypaar je
  VPS-Ziel-Name, verschlüsselt im CredentialStore, via cloud-init
  `ssh_keys:` eingebettet (CloudInitBuilder v6). EP 6.5/5.0, 2 Iter.
- S-418 / REAL_SEND-Gate + Test-Config-Leitkanal (AC9/AC10): Hard-Strip
  von FLASHRESCUE_REGRESSION_ALLOW_REAL_SEND vor spawn; AC11 nicht live
  verifiziert. EP 3/4.
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8): .env.gpg-Entschlüsse-
  lung nur in die Playwright-Kind-Env; fehlendes Secret → Skip. EP 4/5.25.
- S-414 / config-failed-Meldung im Validate-Katalog (AC22). F-072 komplett.
- S-386 / Done-Nachtrag: bw-Appdata-Fix war als PR #431 längst gelandet.

## Offene Fäden
- ⚠ F-052 Merge-Vorbehalt: Live-Verifikation (delete()+create()-Rebuild
  + SSH-Connect) vor Merge — docs/specs/vps-host-key-stabilitaet.md.
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne findings/checks-Array —
  Parser liefert auswertbar:false, Store bleibt leer. Owner-Entscheid
  offen (Skill-Erweiterung in agent-flow).
- Vor F-096-Merge: ADR-Eintrag zu A1 (Playwright-Browser fest im Image,
  zentrales Versions-Pinning) in docs/architecture.md; AC11-Live-Lauf
  braucht -v-Config-Mount am flashrescue-Container.
- Landen aus Worktree: Modus B (--target-branch) läuft (flow/L09);
  Modus A weiter von Hand (flow/L07, Retro-Issue #371 offen).
F-099 (Nachtwächter-Leerlauf) ist inhaltlich komplett: S-427
(Vorab-Skip) und S-428 (Waiting-Status) sind beide in feature/F-099
gelandet (2/2 Done). Es fehlt nur noch der gebündelte Feature-Merge in
main (board-feature-drain.sh --merge-feature feature/F-099) inkl.
Rollout. F-072, F-095, F-050, F-097 sind komplett.
Wichtig (F-095): das reale red-team-End-JSON liefert nur einen
Fund-Zähler, daher liefert der Parser heute immer `auswertbar:false` —
der Store bleibt leer (ehrliche Degradation), bis der red-team-Skill
strukturierte Arrays liefert.

## Letzte Arbeiten
- S-428 / Waiting-Status dev-gui-Anteil (AC1–AC5): Backend rein additiv
  per Regressionstests verankert (Waiting wie Blocked/Idee, keine
  Logik-Änderung); Frontend eigene ruhige Spalte „Wartet (extern)" mit
  wait_reason-Default in BoardView.jsx. Board-Assertions zählen jetzt
  8 Status. EP 4 (geschätzt 5.25). In feature/F-099 gelandet.
- S-427 / Nachtwächter-Vorab-Skip (AC1–AC4): computeDrainState-Gate vor
  #startDrain in NightWatchScheduler.js, gedrosselter Audit-Vermerk.
  Test-Fixtures brauchen jetzt ein features-Feld, sonst greift der
  Skip. EP 4/4. In feature/F-099 gelandet.
- S-386 / Done-Nachtrag: Fix war als PR #431 längst auf main + deployt;
  Session hat nur den Board-Status nachgezogen. Keine Metrik.
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`.
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks`
  über den Detail-Endpunkt nach; Ampel-Konstanten geteilt. EP 4/4.

## Offene Fäden
- F-099: Feature-Merge in main + Rollout ausstehend — übernimmt
  board-feature-drain.sh am Batch-Ende (nicht je Story).
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer (nie
  falsches Grün). Owner-Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- board-ship.sh Modus B hängt reproduzierbar NACH erfolgreichem
  Merge+Push (S-427 + S-428) — Remote-State prüfen, Restschritte von
  Hand (flow/L11); Modus A weiter von Hand (flow/L07, Retro-Issue #371).
- Testläufe im Worktree: npm run test:worktree (S-400).
F-098 (Leerlauf-Berichts-Hygiene) ist mit S-426 komplett auf
feature/F-098 — der Feature-Drain kann den gebündelten Merge in main
fahren. F-096 (target:local-Regressionslauf) liegt vollständig auf
feature/F-096 und wartet ebenfalls auf den Feature-Merge (vorher
ADR-Eintrag zu A1 nachziehen, s. Offene Fäden). F-072 (Deploy-Bitwarden)
verbleibt S-414. F-099 (S-427/S-428) ist angelegt, Stories noch nicht
ready. Der echte AC11-Live-Lauf (flashrescue-Verbund aus der Oberfläche,
F-096) steht als Owner-Verifikation aus.

## Letzte Arbeiten
- S-426 / Leerlauf-Berichte aggregieren (AC8–AC10 drain-completion-
  report): Done-Nachtrag — Story-Commit 2d0ec75 (DrainReportStore
  Merge-on-persist, idempotente Lade-Kompaktion, Serien-Zeile in
  NightRunsSection, GET /api/drain-reports additiv firstAt/lastAt/count)
  lag schon auf feature/F-098; Feature-Drain hatte die Story fälschlich
  auf To Do zurückgesetzt. Voller Testlauf grün (8660 Tests). Keine
  Metrik-Zeile (keine Dispatches dieser Session).
- S-418 / REAL_SEND-Gate + Test-Config-Leitkanal (AC9/AC10 regression-
  local-execution): Hard-Strip in defaultRunPlaywright; voller Env-
  Durchgriff als Leitkanal. AC11 nicht live verifiziert. EP 3/4.
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8): resolveLocal-
  RegressionSecrets — .env.gpg via gpg -d, Secrets nur in die
  Playwright-Kind-Env; fehlendes Secret → kontrollierter Skip. EP 4/5.25.
- S-419 / Verbund-Scope ohne id (AC13): validateScope akzeptiert
  { typ: "verbund" }. EP 3/3.
- S-416 / Port + Ziel-Adressierung (AC4–AC6): host.docker.internal vs
  127.0.0.1-Auflösung. EP 4/7.
- S-386 / Done-Nachtrag F-072: Fix war als PR #431 längst auf main +
  deployt; nur Board-Status nachgezogen, keine Metrik.

## Offene Fäden
- Vor dem F-096-Merge: ADR-Eintrag zu A1 (Playwright-Browser fest im
  Image + zentrales Versions-Pinning) in docs/architecture.md.
- AC11-Live-Verifikation braucht -v <host>:/app/config-Mount am
  flashrescue-Container (Deployment-Voraussetzung, kein dev-gui-Code).
- ⚠ F-095: red-team-End-JSON ohne findings/checks-Array — Store bleibt
  leer (ehrliche Degradation), bis der Skill strukturierte Arrays
  liefert. Owner-Entscheid offen.
- VALIDATE_ERROR_MESSAGES kennt config-failed nicht — S-414 (F-072).
- Feature-Drain-Reset vs. gelandete Arbeit: Drain setzt liegengebliebene
  Stories auf To Do zurück, ohne zu prüfen, ob der Story-Commit schon im
  Feature-Branch liegt — vor coder-Dispatch immer flow/L10-Check.
- Landen aus Worktree: Modus B (--target-branch) läuft (flow/L09);
  Modus A von Hand (flow/L07, Retro-Issue #371 offen).
- Testläufe im Worktree: npm run test:worktree (S-400) bzw. temporäre
  jest.worktree.config.mjs.
