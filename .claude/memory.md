> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
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
- Testläufe im Worktree: npm run test:worktree (S-400).
