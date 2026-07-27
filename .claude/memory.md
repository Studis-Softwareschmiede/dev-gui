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
