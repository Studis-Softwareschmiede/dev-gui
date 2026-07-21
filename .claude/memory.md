> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-093 „Red-Team-Scan pro Container" läuft (Spec red-team-scan-per-container,
7 Stories S-401..S-408, Feature-Branch feature/F-093). Der Scan wird künftig
über einen Knopf pro laufender App in der VPS-Container-Übersicht ausgelöst —
KEINE eigene Kachel; die eigenständige Red-Team-Kachel wird per S-408
abgebaut (Runner HeadlessRedTeamRunner bleibt, wird wiederverwendet).
S-401 gelandet (Backend-Fundament): confinierter Pro-Container-Endpunkt
POST/GET .../containers/:containerId/scan, dockt den bestehenden Runner an,
Ziel-URLs rein server-seitig abgeleitet (SSRF-fest). Nächste bereite Story:
S-402 (ScanResultStore + Verlauf-Endpunkte).

## Letzte Arbeiten
- S-401 / Pro-Container-Scan-Endpunkt (AC1-AC6,AC22): neuer Router
  vpsContainerScanRouter.js + Auto-Discovery vpsContainerScan.js, Runner
  wiederverwendet, 409-Guard via mapStatus. EP 6.5 vs. 5.25. 2 Iterationen
  (Reviewer-Fund: budget-limited nicht terminal im 409-Guard, behoben).
- S-388 / GUI-Kombifeld Obsidian-Ingest + ensure-Statusanzeige (AC10/AC15).
- S-387 / ensure-target-Endpunkt: 4 Review-Runden (Prompt-Injection-Guard,
  checkMutationAuthz, GPG-Naht scaffoldOk, TOCTOU).
- S-383/S-384 / Ingest-cwd-Fix (Ziel-Repo statt Vault-Ordner); als be5ef44.

## Offene Fäden
- S-402 hängt den echten ScanResultStore nur noch in server.js-deps ein
  (Boundary scanResultStore.getByJobId bereits verdrahtet, kein Router-Change).
- phase ist coarse (direkt/fertig) — der Runner hat kein Zwischen-Signal;
  S-403-UI muss damit rechnen. activeJobs-Maps ohne Pruning (bewusst).
- Supervised Live-Smoke des echten from-notes-Laufs (neuer cwd/argv) offen.
- Retro: Issue #371 (board-ship.sh worktree-tauglich) bleibt offen — Landen
  bei --parent muss weiter von Hand deterministisch gefahren werden (flow/L02).
