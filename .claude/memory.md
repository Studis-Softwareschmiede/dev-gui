> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
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
