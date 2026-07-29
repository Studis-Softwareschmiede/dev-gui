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
