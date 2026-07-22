---
id: red-team-scan-per-container
title: Red-Team-Scan pro Container — direkt + Cloudflare-Wand, Verlauf, Befunde→Board
status: active
area: deployment
version: 1
spec_format: use-case-2.0
---

# Spec: Red-Team-Scan pro Container  (`red-team-scan-per-container`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge für einen **Sicherheits-/Red-Team-Test einer
> bereits laufenden, deployten App** direkt aus der dev-gui heraus — ausgelöst über einen **Knopf pro
> laufender App** in der VPS-Container-Übersicht (**keine eigene Kachel**). Ausbaustufe 1.

## Zweck

Der Betreiber kann eine laufende, deployte App (VPS-Container) mit einem KI-Red-Team-Agenten testen —
**ohne** die dev-gui zu verlassen und **ohne** ein Ziel von Hand einzutippen. Getestet werden zwei Orte
zugleich: die App **direkt** (lokaler Container-Port) und die App **über Cloudflare** (öffentliche URL =
die Absperrung davor). Befunde landen in einem persistierten Verlauf pro App und können — **nur auf
Bestätigung** — als Board-Punkte übernommen werden.

## Kontext & Grenzen (bindend)

- **Andockpunkt UI:** `client/src/VpsView.jsx`, `ContainerRow`-Button-Leiste (neben
  Start/Stop/Neustart/Update/Logs/Entfernen). **Kein** neuer Menüpunkt, **keine** eigene Kachel.
- **Andockpunkt Backend:** neuer **Pro-Container**-Endpunkt in `src/vpsContainerRouter.js` (Muster der
  bestehenden `/containers/:containerId/*`-Routen) bzw. ein neuer Auto-Discovery-Router
  (`src/routers/*.js`, `create(deps)` + `order`) analog `src/routers/obsidianIngest.js`.
- **Scan-Engine (entschieden, Owner 2026-07-21):** **KI-Red-Team-Agent, KEIN Standard-Tool** (ZAP/Nuclei
  o. ä.). **Kein neuer Runner** — der **bestehende** `src/HeadlessRedTeamRunner.js` (gelandet, F-090/F-091)
  wird **wiederverwendet** und hinter den neuen Pro-Container-Endpunkt in `src/vpsContainerRouter.js`
  verdrahtet. Er unterstützt bereits `ziel`/`modus`/`url`/`url_edge` und fährt `claude -p '/agent-flow:red-team …'`:
  **direkt** über `url` (lokaler Container-Port) + **über Cloudflare** über `url_edge` (öffentlicher Hostname).
- **Beziehung zum bestehenden `red-team-tile`-Subsystem (Owner-Entscheidung 2026-07-21: ERSETZT):** Dieses
  Feature **ersetzt** die eigenständige Red-Team-Kachel — der **Container-Knopf wird der einzige Einstieg**.
  Die **Kachel-UI/Router-Schicht** (`client/src/RedTeamView.jsx`, `src/redTeamRouter.js`, `src/routers/redTeam.js`,
  Registry-Eintrag in `client/src/viewRegistry.js`) wird **abgebaut** (AC23), und [[red-team-tile]] wird als
  **superseded/abgelöst** markiert. **Der Runner `src/HeadlessRedTeamRunner.js` bleibt** (wird wiederverwendet,
  s. o.) — nur die kachel-spezifische Oberflächen-/Endpunkt-Schicht entfällt.

## Verhalten

1. **Auslösen.** Klick auf den „Red-Team-Scan"-Knopf einer **managed** laufenden App (`state === 'running'`,
   `hostname !== null`) startet einen Scan-Job. Der Knopf geht sofort in „läuft…" (gesperrt, Spinner,
   mitlaufende Uhr). Ein zweiter Klick während des Laufs ist wirkungslos (Server-Lock + Client-Sperre).
2. **Zwei Testorte, ein Lauf.** Der Job prüft **beide** Orte, ohne Doppel: (1) **direkt** gegen die
   Container-Adresse (VPS-Host + veröffentlichter `hostPort`) = die App selbst; (2) **über Cloudflare**
   gegen die öffentliche URL (`https://<hostname>`) = die Absperrung davor (greift Cloudflare Access? App
   versehentlich ohne Login erreichbar? Tunnel korrekt?).
3. **Ziel-Confinement.** Beide Ziel-URLs werden **server-seitig** aus dem ausgewählten ContainerEntry
   abgeleitet. Es gibt **kein** Freitext-URL-Feld; ein client-gelieferter URL-Wert wird ignoriert/abgelehnt.
4. **Fortschritt.** Ein Live-Panel (Muster `ObsidianIngestOverlay`) zeigt Phasen
   (Direkt-Scan → Cloudflare-Scan → N Befunde → fertig) und pollt bis fertig/Fehler.
5. **Ergebnis.** Am Ende: **Ampel** (grün/gelb/rot) + Befund-Kurzliste + Link zum vollen Bericht. Fehler/
   Abbruch werden klar gemeldet, nie still.
6. **Verlauf.** Jeder Lauf wird persistiert (pro App). Ein „Verlauf"-Aufklapper am Container listet die
   Läufe; Klick öffnet den Detailbericht.
7. **Befunde → Board (nur auf Bestätigung).** Aus der Befundliste können ausgewählte Befunde als
   Board-Punkte übernommen werden. Der Verlaufseintrag merkt sich die entstandenen Board-IDs und zeigt je
   Scan „daraus wurden N Punkte aufs Board gelegt — Status live vom Board".

## Acceptance-Kriterien

### Engine & Confinement

- **AC1 — Bestehenden Runner am confinierten Pro-Container-Endpunkt andocken (kein neuer Runner).** Der
  **bestehende** `src/HeadlessRedTeamRunner.js` wird hinter den neuen Pro-Container-Endpunkt (AC2) verdrahtet
  und mit **server-seitig aus den Container-/Tunnel-Metadaten abgeleiteten** Argumenten gestartet:
  `ziel=<container-referenz>`, `modus=beide`, `url=<direkt>` (lokaler Container-Port), `url_edge=<öffentlich>`
  (Cloudflare-Hostname). Der Runner behält seine bestehende Semantik (eigene `ProjectJobLock`-Instanz,
  `close`-Event als einzige Fertig-Quelle, Runaway-Timeout, secret-freies Per-Lauf-Audit, argv-Array,
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block, kein `PtyManager`/`CommandService`). Es wird **kein** zweiter/
  paralleler Runner gebaut.
  **Präzisierung (S-401 — `<container-referenz>` + Spawn-Verzeichnis):** der Runner braucht ein
  aufgelöstes Projekt-Verzeichnis als Spawn-`cwd` (`ProjectJobLock`-Schlüssel). Der Container wird dafür
  über `imageRepoName(image)`/`hostname` auf einen Workspace-Klon gemappt (identische Matching-Logik wie
  der abzulösende `redTeamRouter.js#computeAllowlist`, S-408) — `ziel` = der ermittelte Repo-Slug. Kein
  Match (Container ohne lokalen Klon im Workspace) → `422 not-scannable` (kein Freitext-Fallback). Diese
  Wahl gibt jedem Repo/Container ein EIGENES Lock-Verzeichnis, sodass Scans für unterschiedliche
  Container/Repos einander nicht blockieren (AC5).
- **AC2 — Start-Endpunkt (pro Container).** `POST /api/vps/machines/:provider/*splat/containers/:containerId/scan`
  → `202 { jobId, status: "running" }`. Nur **managed, laufende** Container (`hostname !== null`,
  `state === 'running'`) — sonst `422 { errorClass: "not-scannable" }`. Bereits laufender Scan für denselben
  Container → `409 { errorClass: "scan-in-progress" }`. Provider/serverId/containerId werden wie in den
  bestehenden Container-Routen aufgelöst/validiert.
- **AC3 — Status-Endpunkt.** `GET /api/vps/machines/:provider/*splat/containers/:containerId/scan/:jobId`
  → `200 { status, phase, ampel?, findings?, reportRef? }` mit `status ∈ {running, done, failed, auth-expired}`
  und `phase ∈ {direkt, cloudflare, auswerten, fertig}`; `404` bei unbekannter `jobId` (auch wenn eine
  ansonsten bekannte `jobId` zu einem ANDEREN Container gehört — kein Cross-Container-Leak).
  **Präzisierung (S-401, Backend-Fundament — kein Zwischen-Fortschritts-Signal in dieser Iteration):**
  der wiederverwendete `HeadlessRedTeamRunner` ist ein opaker Kindprozess ohne Zwischenstands-Meldung
  (`close` bleibt die einzige Fertig-Quelle, s. `HeadlessRunnerCore`) — `phase` ist deshalb **coarse**:
  `direkt` solange `status === 'running'`, `fertig` in jedem Terminalzustand (`done`/`failed`/
  `auth-expired`). Eine granulare `cloudflare`/`auswerten`-Zwischenphase erfordert eine stdout-
  Fortschritts-Erkennung, die NICHT Teil dieser Story ist (Kandidat für eine Folge-Iteration/S-403,
  sobald der Live-Fortschritts-Panel-Bedarf das rechtfertigt). Der Core kennt zusätzlich einen fünften
  internen Status `budget-limited` (headless-budget-limit-detection, unabhängig von dieser Spec) — er
  wird am Pro-Container-Endpunkt defensiv auf `failed` gemappt, damit der `status`-Enum dieser Story
  exakt bei den vier genannten Werten bleibt.
- **AC4 — Ziel-Confinement (sicherheitskritisch).** Die beiden Scan-Ziele werden **ausschließlich
  server-seitig** aus dem ContainerEntry abgeleitet: **direkt** = VPS-Host + veröffentlichter `hostPort`;
  **öffentlich** = `https://<hostname>`. Es existiert **kein** Freitext-URL-Feld und **kein**
  URL-Request-Parameter; ein dennoch mitgeschickter URL-Wert wird **ignoriert** (Default-deny). Ein Ziel
  außerhalb des ausgewählten Containers ist konstruktiv **nicht** erreichbar.
- **AC5 — Zwei Testorte, kein Doppel.** Der Lauf prüft **beide** Orte (direkt + öffentlich) in **einem**
  Job; das Ergebnis ordnet jeden Befund seinem **Testort** (`direkt | öffentlich`) zu. Keiner der beiden
  Orte wird doppelt gescannt.
- **AC6 — Wiring.** `server.js` reicht den **bestehenden** `redTeamRunner` (`HeadlessRedTeamRunner`) + die
  für den Endpunkt nötigen Boundaries (`vpsDockerControl`/`vpsTargets`/`vpsRegistry`, `scanResultStore`) in
  den Pro-Container-Router; die Route hängt an `src/vpsContainerRouter.js` (bzw. einem Auto-Discovery-Router
  `create(deps)` + `order`), ohne die bestehende Router-Reihenfolge-Invariante zu verletzen. Kein neuer
  Runner-Typ.

### Persistenz & Verlauf

- **AC7 — ScanResultStore.** `src/ScanResultStore.js`: **dateibasiert** unter `${CRED_STORE_DIR}`
  (Muster `DrainReportStore`/`RegressionResultStore`), **atomarer** Schreibzugriff (tmp + rename), Rechte
  `0600`, **pro-App size-begrenzte** Historie (feste Obergrenze je App). Ohne `CRED_STORE_DIR`
  degradiert der Store auf **In-Memory** (kein Crash). Eintrag-Schema (verbindlich):
  `{ scanId, app, startedAt, finishedAt, ampel, findings: [{ id, severity, kind, testort, titel }],
  findingCount, reportRef, boardItemIds: [] }` — `app` = Hostname/Slug (kein Host-Pfad), `ampel ∈
  {gruen, gelb, rot}`.
  **Präzisierung (S-402 — Fundament, Schreibpfad ausserhalb des Story-Scopes):** `scanId` ≡ die
  Runner-`jobId` (AC1-AC3) — der (künftige) Aufrufer, der einen abgeschlossenen Lauf persistiert,
  übergibt dieselbe Korrelations-ID durchgängig; `ampel`/`findingCount` werden vom Store IMMER
  deterministisch aus `findings` abgeleitet (nie vom Aufrufer übernommen, single source of
  truth, s. AC9). Diese Story implementiert nur das Store-Fundament (`record`/`list`/
  `getByScanId`/`getByJobId`) — WER `record()` nach Lauf-Abschluss aufruft (Parsing des
  Agent-Outputs zu `findings`), ist nicht Teil von AC7-AC9 und bleibt eine offene Folge-Naht.
  **Präzisierung (S-405 — zusätzliche Felder für AC16/AC17):** das Schema wird um
  `repoSlug: string|null` (Scan-Ebene, identisch zu `ziel` aus AC1 — der Workspace-Repo-Slug für
  den Board-Übertrag) und `boardId: string|null` (je Finding — Idempotenz-Grundlage, `null` bis
  übertragen) erweitert. Beide Felder sind optional/additiv (`null`-Default) — bestehende
  Verlaufseinträge ohne diese Felder bleiben gültig; der künftige `record()`-Aufrufer (weiterhin
  offene Naht, s.o.) sollte `repoSlug` mitgeben, sobald er existiert (er kennt ihn bereits aus
  AC1). `ScanResultStore.recordBoardTransfer({scanId, transfers})` (AC17) ist der einzige
  Schreibpfad für `boardId`/die Ergänzung von `boardItemIds`.
- **AC8 — Verlauf-Lese-Endpunkte.** `GET …/containers/:containerId/scans` → Liste der Verlaufseinträge
  (neueste zuerst, ohne Rohbericht-Volltext); `GET …/scans/:scanId` → Detail inkl. Referenz auf den
  Rohbericht. Beide read-only.
  **Präzisierung (S-402):** beide Routen hängen — wie die AC2/AC3-Endpunkte — unter demselben
  `/api/vps/machines/:provider/*splat`-Präfix (`vpsContainerScanRouter.js`): `GET
  …/containers/:containerId/scans` löst den Container über dieselbe Provider/ServerId/
  ContainerId-Auflösung wie AC2 auf und filtert den Store über `app = container.hostname`;
  `GET …/scans/:scanId` ist containerId-unabhängig (`scanId` ist bereits global eindeutig). Jede
  Auflösungs-Lücke der Listen-Route (kein Store, kein VPS-Ziel, Container nicht gefunden,
  unmanaged ohne `hostname`, Store-Fehler) liefert best-effort `200 { scans: [] }` statt eines
  weiteren Fehlercodes (Robustheit-NFR: ein read-only Verlauf-Abruf darf nie crashen); die
  Detail-Route liefert bei fehlendem Store/unbekannter `scanId`/Store-Fehler einheitlich `404`.
- **AC9 — Ampel-Ableitung (deterministisch).** `gruen` = keine Befunde; `gelb` = ausschließlich
  low/medium-Befunde; `rot` = mindestens ein high/critical-Befund. Die Ableitung ist eindeutig und
  testbar aus der `findings`-Liste.

### Fortschritt & Ergebnis (UI)

- **AC10 — Scan-Knopf.** In `client/src/VpsView.jsx` `ContainerRow` (neben Start/Stop/…) ein
  „Red-Team-Scan"-Knopf **nur** für managed, laufende Container. Klick → sofort „läuft…" (gesperrt,
  Spinner, mitlaufende Uhr). Doppelklick bleibt wirkungslos (Client-Sperre + Server-`409`).
- **AC11 — Live-Fortschritts-Panel.** Panel (Muster `ObsidianIngestOverlay`) zeigt die Phasen
  (Direkt-Scan → Cloudflare-Scan → N Befunde → fertig) und pollt den Status-Endpunkt bis `done`/Fehler.
- **AC12 — Ergebnis-Anzeige.** Am Ende: **Ampel** (grün/gelb/rot) + Befund-Kurzliste + **Link zum vollen
  Bericht**.
- **AC13 — Fehler/Abbruch klar.** `failed`/`auth-expired`/Timeout werden mit klarer Meldung angezeigt —
  **nie** still (kein hängender Spinner, kein leerer Endzustand).

### Verlauf-UI & Board-Rückverfolgung

- **AC14 — Verlauf-Aufklapper.** Am Container ein „Verlauf"-Aufklapper: Liste der Läufe (Zeitpunkt,
  Testort, Ampel, Befund-Anzahl+Art, Bericht-Referenz); Klick öffnet den Detailbericht (`GET …/scans/:scanId`).
- **AC15 — Board-Rückverfolgung (live).** Trägt ein Verlaufseintrag `boardItemIds`, zeigt der Verlauf je
  Scan „daraus wurden N Punkte aufs Board gelegt — Status live vom Board"; der Board-Status wird **live**
  gelesen (keine eigene DB — ADR-005-Linie).

### Befunde → Board (nur auf Bestätigung)

- **AC16 — Übertrag-Endpunkt (kein Auto-Anlegen).** `POST …/scans/:scanId/board` Body
  `{ findingIds: string[] }` legt **genau** die ausgewählten Befunde als Board-Items an (Inhalt je Item:
  Befund + Details + betroffene App/URL + Referenz auf den Scan). **Idempotent:** ein bereits übertragener
  Befund wird **nicht** erneut angelegt (Antwort nennt die bestehende Board-ID). Ohne Auswahl (leere Liste)
  → `400`. Unbekannte `scanId` → `404`.
  **Präzisierung (S-405 — Board-Item-Anlage + Idempotenz-Mechanik + Projekt-Auflösung):**
  Board-Items werden über den bestehenden, einzigen programmatischen Schreibpfad
  `BoardWriter.createIdea()` (S-199, `src/BoardWriter.js`) als neue Story mit `status: Idee`
  angelegt (kein neuer Board-Schreibmechanismus) — Titel = Kurzform des Befunds, Body = Details
  (Schweregrad/Art/Testort) + betroffene App + Scan-Referenz. Die Idempotenz-Prüfung ist **je
  Befund**: jedes `ScanFinding` trägt zusätzlich `boardId` (`null` bis übertragen, danach die
  entstandene Board-Story-ID) — ein Befund mit bereits gesetztem `boardId` wird als `skipped`
  gemeldet, nie erneut angelegt; unbekannte `findingIds` (kein Treffer im Scan) werden still
  ignoriert. Für die Zuordnung "in welches Workspace-Repo (`board/stories/`) gehört dieser
  Befund" trägt der `ScanResultStore`-Eintrag zusätzlich `repoSlug` (identisch zu `ziel` aus
  AC1) — fehlt es (älterer/unvollständiger Eintrag) und es müssen tatsächlich NEUE Befunde
  angelegt werden (reine Idempotenz-Treffer sind davon nicht betroffen), antwortet der Endpunkt
  mit `422 { errorClass: 'not-scannable' }` (reuse der bereits etablierten Fehlerklasse aus
  AC1/AC2, kein neuer Fehlercode). Ein einzelner fehlgeschlagener Transfer (z. B. Board-Schreibfehler)
  bricht die übrigen Befunde nicht ab (best-effort, analog `BoardWriter.archiveDoneFeatures()`).
- **AC17 — Board-IDs zurückschreiben.** Die entstandenen Board-IDs werden in den `boardItemIds` des
  zugehörigen `ScanResultStore`-Eintrags persistiert (Grundlage für AC15).
  **Präzisierung (S-405):** `ScanResultStore.recordBoardTransfer({scanId, transfers})` setzt je
  Befund `boardId` (nur wenn noch nicht gesetzt — Idempotenz) und ergänzt `boardItemIds` um die
  neu entstandenen IDs (dedupliziert); best-effort/non-fatal (ein Schreibfehler hier darf die
  Response nicht kippen — die Board-Items sind zu diesem Zeitpunkt bereits real angelegt).
- **AC18 — Befundliste mit Vorauswahl.** Die Befundliste zeigt je Befund eine Checkbox; **alle** sind per
  Default **vorgehakt** (der Betreiber entfernt nur, was **nicht** aufs Board soll). Schnellwahl oben:
  **Alle / Keine / Nur kritische**.
  **Präzisierung (S-406):** „Nur kritische" wählt Befunde mit `severity ∈ {high, critical}` —
  identisch zur `deriveAmpel()`-Rot-Schwelle (AC9) und zum bestehenden UI-Vokabular
  („Rot — kritische Befunde", AC12). Die Checkbox-/Schnellwahl-Interaktion bezieht sich auf
  die in der Kurzliste **gezeigten** Befunde (AC12-Truncation, `MAX_FINDINGS_SHOWN`) — über
  die Kurzliste hinausgehende „N weitere"-Befunde sind aus dieser Ansicht heraus nicht
  einzeln wählbar (Bestandsverhalten aus S-403, hier unverändert respektiert).
- **AC19 — Sticky Sammel-Button.** Unten fest sichtbar (sticky) ein Button „N Befunde aufs Board
  übertragen" mit **live mitzählender** Zahl; bei 0 Auswahl **grau/gesperrt**. Klick → kurze Rückfrage
  („N Befunde werden aufs Board gelegt — übertragen?") → Übertrag der ausgewählten Befunde (AC16).
- **AC20 — Nach-Übertrag-Zustand.** Nach dem Übertrag zeigt die Zeile statt der Checkbox
  „→ aufs Board gelegt (ID)" und ist **gesperrt** (kein erneuter Übertrag — Idempotenz sichtbar).

### Zugang & Security

- **AC21 — Auslösen ohne feinere Rolle.** Jeder mit dev-gui-Zugang **hinter Cloudflare Access** kann einen
  Scan auslösen (keine feinere Rolle) — **bewusste Owner-Entscheidung**. (Abweichung von den mutierenden
  Container-Routen, die einen Rollencheck tragen; hier bewusst nicht.)
- **AC22 — Security-Floor.** Keine Secrets/Tokens/absoluten Host-Pfade in Response/Log/Audit;
  `jobId`/`scanId` = Korrelations-IDs; argv als Array (kein Shell-Interpolation); Confinement **server-**
  **seitig** (nicht nur UI); `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`-Block aus dem Core.

### Kachel-Rückbau (Ersetzung der eigenständigen Red-Team-Kachel)

- **AC23 — Kachel-Abbau, Runner bleibt.** Nachdem der Container-Knopf-Pfad steht (AC1–AC6 + AC10–AC13),
  wird die **eigenständige** Red-Team-Kachel entfernt — der Container-Knopf ist der **einzige** Einstieg:
  `client/src/RedTeamView.jsx`, `src/redTeamRouter.js`, `src/routers/redTeam.js` und die Kachel-Registrierung
  in `client/src/viewRegistry.js` werden **abgebaut**, zugehörige Kachel-Tests entfernt/angepasst, und
  [[red-team-tile]] wird auf `status: superseded` gesetzt (abgelöst durch diese Spec). **`src/HeadlessRedTeamRunner.js`
  bleibt bestehen** (wird über AC1 wiederverwendet) — nur die kachel-spezifische UI-/Router-Schicht entfällt.
  Nach dem Abbau referenziert **kein** aktiver Code mehr die entfernten Kachel-Endpunkte (`/api/red-team*`).

## Verträge

- **`POST …/containers/:containerId/scan`** → `202 { jobId, status:"running" }` | `409 scan-in-progress`
  | `422 not-scannable` | `400` (ungültige Route/Container).
- **`GET …/containers/:containerId/scan/:jobId`** → `200 { status, phase, ampel?, findings?, reportRef? }`
  | `404`.
- **`GET …/containers/:containerId/scans`** → `200 { scans: [{ scanId, startedAt, ampel, findingCount,
  boardItemIds }] }`.
- **`GET …/scans/:scanId`** → `200 { scan: { …, findings:[…], reportRef } }` | `404`.
- **`POST …/scans/:scanId/board`** Body `{ findingIds: string[] }` → `200 { created:[{ findingId, boardId }],
  skipped:[{ findingId, boardId }] }` | `400` (leere Liste) | `404` (unbekannte scanId) |
  `422 not-scannable` (kein `repoSlug` beim Scan-Eintrag UND es müssen neue Befunde angelegt werden).
- Runner-Args (server-seitig gesetzt, argv-Array): Ziel-App-Referenz + abgeleitete `url`/`url_edge` +
  `modus=beide` an `claude -p <red-team-command>`.

## Edge-Cases & Fehlerverhalten

- **Direkt-Ziel nicht erreichbar** (VPS-Firewall blockt den Host-Port): dieser Testort meldet klar
  „direkt nicht erreichbar" statt still zu scheitern; der Cloudflare-Testort läuft weiter.
- **Öffentliche URL nicht auflösbar / Tunnel fehlt:** klare Fehlmeldung pro Testort, Gesamt-Status
  `failed` nur wenn **beide** Orte scheitern.
- **`/agent-flow:red-team` liefert kein/kein parsebares Ergebnis:** der (wiederverwendete) Runner endet
  `failed` mit klarer Meldung — **nie** stiller Erfolg / keine erfundenen Befunde (fail-safe, bestehende
  Runner-Semantik).
- **`auth-expired`** (OAuth-Token abgelaufen): Status `auth-expired`, klare Meldung (Muster der übrigen
  Headless-Runner).
- **Server-Neustart während Lauf:** In-Memory-Job-Registry geht verloren (kein Ziel: persistente
  Job-Historie); der Verlaufseintrag entsteht nur bei sauberem Abschluss.
- **Übertrag doppelt geklickt / Befund schon übertragen:** idempotent (AC16/AC20), keine Duplikate.

## NFRs

- **Security:** getrennter Headless-Pfad (eigener Lock, kein PTY-Lock, kein API-Key); Confinement
  server-seitig; secret-freies Audit/Log.
- **Robustheit:** Store-/Schreibfehler sind best-effort/non-fatal (Scan darf durch fehlende Persistenz nie
  crashen); Runaway-Timeout terminiert hängende Läufe.
- **Beobachtbarkeit:** je Lauf genau ein Audit-Eintrag bei Start/Ende/Fehler (secret-frei).

## Nicht-Ziele

- **Kein** Freitext-URL-Ziel (nur container-confined).
- **Kein** Auto-Anlegen von Board-Items (immer nur auf Bestätigung).
- **Kein** Test der App **hinter** der Access-Wall via Service-Token — das ist **Ausbaustufe 2**
  ([[red-team-scan-access-token]]).
- **Keine** eigene Kachel/kein neuer Menüpunkt.
- **Keine** Cloudflare-Umkonfiguration durch den Scan.

## Abhängigkeiten

- **Wiederverwendet (bestehend, gelandet):** `src/HeadlessRedTeamRunner.js` (fährt `claude -p '/agent-flow:red-team …'`,
  unterstützt `ziel`/`modus`/`url`/`url_edge`) — **kein** neuer Runner, **keine** offene Cross-repo-Vorbedingung.
- `HeadlessRunnerCore` (`src/HeadlessRunnerCore.js`), `ProjectJobLock`, Audit-Muster.
- `src/vpsContainerRouter.js` (Container-Auflösung + ContainerEntry: `hostname`, `hostPort`, `state`;
  Tunnel-/Ziel-Metadaten für `url`/`url_edge`).
- Store-Muster: `src/DrainReportStore.js` / `src/RegressionResultStore.js`.
- UI-Muster: `client/src/ObsidianIngestOverlay.jsx`, `client/src/VpsView.jsx`.
- **Löst ab (Owner-Entscheidung 2026-07-21):** [[red-team-tile]] (F-090/F-091, eigenständige Kachel) — die
  Kachel-Schicht wird per AC23 abgebaut, der Runner bleibt.
- Folge-Stufe: [[red-team-scan-access-token]] (Ausbaustufe 2).
