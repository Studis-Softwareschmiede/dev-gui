> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-099 (Nachtwächter-Leerlauf) läuft als Feature-Batch: S-427
(Vorab-Skip) ist gelandet, verbleibt S-428 (Waiting-Status, Label ui —
Design-Freigabe-Gate beachten), dann Feature-Merge in main. F-072
(Deploy-Bitwarden) ist mit S-414 fertig abgearbeitet und gemergt.
F-095 (Red-Team-Report), F-050 (Obsidian-Ingest), F-097 sind komplett.
Wichtig (F-095): das reale red-team-End-JSON liefert nur einen
Fund-Zähler, daher liefert der Parser heute immer `auswertbar:false` —
der Store bleibt leer (ehrliche Degradation), bis der red-team-Skill
strukturierte Arrays liefert.

## Letzte Arbeiten
- S-427 / Nachtwächter-Vorab-Skip (AC1–AC4): computeDrainState-Gate vor
  #startDrain in NightWatchScheduler.js, gedrosselter Audit-Vermerk
  (einmal je Projekt je Nachtfenster), kein Bericht bei Skip. Test-
  Fixtures brauchen jetzt ein features-Feld, sonst greift der Skip.
  EP 4/4. In feature/F-099 gelandet.
- S-386 / Done-Nachtrag: Fix war als PR #431 längst auf main + deployt;
  Session hat nur den Board-Status nachgezogen. Keine Metrik.
- S-413 / Overlay-Text (AC31): Hinweisblock in `RedTeamScanPanel.jsx`,
  sichtbar bei starting/running, weg bei done/Fehler. EP 3/3.
- S-412 / In-App-Report Frontend (AC29/AC30): Panel lädt `scan.checks`
  über den Detail-Endpunkt nach; Ampel-Konstanten geteilt. EP 4/4.
- S-411 / record()-Naht + checks (AC26–AC28): Poll persistiert bei done
  genau einmal (nur `auswertbar:true`). EP 4/4.

## Offene Fäden
- ⚠ F-095-Kernrisiko: red-team-End-JSON ohne `findings`/`checks`-Array —
  ohne Skill-Erweiterung in agent-flow bleibt der Store leer (nie
  falsches Grün). Owner-Entscheid offen.
- F-050 gelandet — GUI-Pfad „Strukturiert starten" gegen agent-flow
  S-098 (`--gui`-Vertrag) real verifizieren.
- board-ship.sh Modus B kann NACH erfolgreichem Merge+Push hängen
  (S-427: 5-min-Timeout) — Remote-State prüfen, Restschritte von Hand
  (flow/P3/L11); Modus A weiter von Hand (flow/L07, Retro-Issue #371).
- Testläufe im Worktree: npm run test:worktree (S-400).
