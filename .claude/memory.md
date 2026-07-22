> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" ist komplett auf main gelandet (Merge
3f28a4a). S-409 (Deploy-Bitwarden-Folge-Bug zu S-386) ist gefixt, gelandet
und ausgerollt: `bw config server` läuft nur noch konditional, damit
funktionieren Folge-Deploys über das persistente eingeloggte bw-Verzeichnis
auch mit wieder gesetztem server_url. Als Nächstes liegt F-095 (Red-Team-
Report + Fund-Extraktion, S-410..S-413) auf dem Board — das schließt die
bisher offene Findings-Naht (record() ohne echte Daten).

## Letzte Arbeiten
- S-409 / bw config konditional (AC17-AC21): #openSession ruft config nur
  noch bei unauthenticated oder abweichender (normalisierter) Server-URL;
  Server-Wechsel = logout→config→login→unlock; neue Fehlerklasse
  config-failed → bitwarden-config-failed im Router. server_url wird NICHT
  auto-befüllt (Owner-Vorgabe). EP 6.5 vs. 5.25 (1 Review-Runde:
  URL-Normalisierung nachgezogen).
- S-408 / Kachel-Rückbau (AC23): Red-Team-Kachel entfernt, 53 Router,
  6 Tiles. EP 4/4.
- S-404 / Verlauf-Aufklapper (AC14/AC15): RedTeamScanHistory.jsx. EP 4/4.
- S-406 / Befundliste (AC18-AC20): Sammel-Button + Rückfrage. EP 7 vs. 4.
- S-405 / Befunde→Board-Übertrag (AC16/AC17): idempotent. EP 4.0/4.0.
- S-403 / Scan-Knopf + Panel: RedTeamScanPanel.jsx. EP 7/5.25.
- S-402 / ScanResultStore: dateibasiert, Cap 30/App. EP 4.0/4.0.
- S-401 / Scan-Endpunkt: vpsContainerScanRouter. EP 6.5/5.25.

## Offene Fäden
- Findings-Extraktion jetzt als F-095 (S-410..S-413) spezifiziert — Stories
  liegen To Do auf dem Board, Naht wird dort geschlossen.
- VALIDATE_ERROR_MESSAGES im bitwardenDeployAccessRouter kennt die neue
  Klasse config-failed nicht (generischer Fallback-Text im „Prüfen"-Button)
  — kleines Folge-Ticket sinnvoll (Reviewer-Suggestion S-409).
- Landen aus Worktree weiter von Hand deterministisch (flow/L02/L07);
  Retro-Issue #371 (board-ship.sh worktree-tauglich) offen.
- Testläufe im Worktree: npm run test:worktree (S-400) statt tar-Workaround.
