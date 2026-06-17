---
id: github-app-token-unification
title: GitHub-Auth vereinheitlichen auf das App-Token-Modell (Cache-Provider, Lese-Pfad)
status: draft
version: 1
---

# Spec: GitHub-Auth vereinheitlichen auf das App-Token-Modell (`github-app-token-unification`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (Auth-Vereinheitlichung; Token-Floor).

## Zweck
**Eine** GitHub-App-Identität deckt in der dev-gui Lesen **und** Schreiben ab — exakt das Modell, mit dem die agent-flow-Skills und `gh` selbst auf GitHub zugreifen. Heute mintet `mintInstallationToken` ([[github-repo-create]] / `src/githubAppToken.js`) bereits für die **schreibenden** Konsumenten (`GitHubWriter`, `GitHubCloner`, `WorkspaceMutator.pullClone()`) ein App-Installation-Token, während der **lesende** Pfad (`GitHubReader`) auf einem separaten `process.env.GH_TOKEN`-PAT läuft. Diese Spec (a) führt einen **gecachten** App-Token-Provider ein, (b) verdrahtet `GitHubReader` darüber und (c) entfernt den `GH_TOKEN`-PAT als **regulären** Mechanismus. Damit entfällt eine zweite, abweichend gepflegte Credential-Quelle, und der Lese-Pfad erbt automatisch die Identität/Permissions der App.

## Verhalten
1. Ein neuer **App-Token-Provider** (Boundary, z.B. `src/GitHubAppTokenProvider.js`) kapselt `mintInstallationToken(credentialStore)` und stellt eine async-Funktion `getToken()` bereit, die ein gültiges Installation-Token liefert.
2. Der Provider **cached** das gemintete Token **in-memory** und gibt bei Folge-Aufrufen das gecachte Token zurück, **solange** es nicht innerhalb einer Sicherheitsmarge vor Ablauf liegt. Installation-Tokens sind ~1h gültig → der Provider behandelt ein Token nur innerhalb eines konservativen Fensters (z.B. ~50 min) als „frisch" und mintet **vor** dem tatsächlichen Ablauf proaktiv neu (Safety-Margin gegen Clock-Skew/Latenz).
3. **Concurrency-sicher:** Sind mehrere `getToken()`-Aufrufe gleichzeitig „on the wire" während kein gültiges Token gecacht ist, wird **genau ein** Mint ausgelöst; parallele Aufrufer teilen dieselbe in-flight-Promise (kein N-faches Minten). Schlägt der gemeinsame Mint fehl, wird die in-flight-Promise verworfen, sodass der nächste Aufruf erneut minten kann (kein dauerhaft „vergifteter" Cache).
4. `GitHubReader` wird im Composition-Root (`server.js`) mit `{ tokenProvider: () => provider.getToken() }` verdrahtet und liest dadurch **über das App-Token** statt über `GH_TOKEN`.
5. Der **`GH_TOKEN`/`GITHUB_TOKEN`-PAT-Pfad** entfällt als regulärer Mechanismus: der Default-Fallback `() => process.env.GH_TOKEN` im `GitHubReader` ist nicht länger der reguläre Lese-Pfad, und die Betriebs-Konfiguration (`docker-compose.yml`, `.env.example`) bietet den PAT nicht mehr als primären Weg an.
6. **Robustheit / graceful degradation:** Fehlt ein github-Katalog-Feld (App-ID/Installation-ID/Private-Key) oder schlägt der Mint fehl, wirft der Provider einen typisierten, **secret-freien** Fehler (`GitHubAppTokenError`-Codes); der `GitHubReader` fängt das ab und degeneriert auf „unbekannt"/leere Liste (wie heute ohne `GH_TOKEN`) — der Server **startet trotzdem** und stürzt nicht ab.
7. Der separate gh-CLI-Auth-Pfad im Container (`ensure-gh-auth.sh`, für die agent-flow-Skills) bleibt **unberührt**; das `unset GH_TOKEN/GITHUB_TOKEN` im `docker-entrypoint.sh` nach der gh-Auth bleibt erhalten.
8. **Vollständiger Wegfall des Env-Lese-Fallbacks im Reader (S-149, DR-verifiziert):** Der Container-Entrypoint (`docker-entrypoint.sh` via `ensure-gh-auth.sh`) mintet weiterhin ein `GH_TOKEN` (`ghs_…`, App-Installation-Token) für die **gh-CLI** der agent-flow-Skills und legt es in die Container-Umgebung — dieser Pfad bleibt unverändert. Der **`GitHubReader`** darf dieses Env-`GH_TOKEN` jedoch **nicht** mehr als Lese-Quelle nutzen: der Konstruktor-Default `() => process.env.GH_TOKEN` entfällt **ganz**. Ohne injizierten `tokenProvider` liefert der Reader **kein** Token und degeneriert graceful auf „unknown"/leere Liste (kein Crash). In `server.js` wird der App-Token-Provider ohnehin injiziert (AC5). Hintergrund: im DR-Test (leerer CredentialStore) las der Reader trotzdem 6 Repos — er fiel auf das vom Entrypoint gemintete Env-`GH_TOKEN` zurück, entgegen AC6.

## Acceptance-Kriterien
- **AC1** — Ein neuer Boundary (`GitHubAppTokenProvider`, eigene Datei z.B. `src/GitHubAppTokenProvider.js`) kapselt `mintInstallationToken` und stellt eine async `getToken(): Promise<string>` bereit. Bei fehlendem gültigem Cache mintet er **genau einmal** ein Token und gibt dessen String zurück.
- **AC2** — **Cache-Hit:** Ein zweiter `getToken()`-Aufruf innerhalb des Gültigkeitsfensters löst **keinen** weiteren Mint aus (testbar: injizierter Mint/`fetchFn` wird nur **einmal** aufgerufen) und liefert denselben Token-String.
- **AC3** — **Refresh vor Ablauf:** Liegt das gecachte Token innerhalb der Sicherheitsmarge vor Ablauf (bzw. ist es abgelaufen), löst der nächste `getToken()` einen **neuen** Mint aus und liefert das neue Token (testbar mit injizierbarer Zeit/Clock und kurzer TTL — der Mint wird ein zweites Mal aufgerufen). Das Gültigkeitsfenster ist konservativ kleiner als die echte ~1h-TTL.
- **AC4** — **Concurrency / kein Doppel-Mint:** Werden bei leerem/abgelaufenem Cache N (≥2) `getToken()`-Aufrufe parallel gestartet, wird der Mint **genau einmal** ausgeführt (testbar: injizierter Mint zählt **1**), und alle N Aufrufer erhalten denselben Token. Schlägt der gemeinsame Mint fehl, wird die in-flight-Promise verworfen → ein **nachfolgender** Aufruf mintet erneut (kein permanent kaputter Provider).
- **AC5** — `GitHubReader` wird in `server.js` mit `{ tokenProvider: () => provider.getToken() }` instanziiert (statt `new GitHubReader()` ohne Provider). Testbar: der Reader fragt sein Token über den Provider/`tokenProvider` ab; der Lese-Pfad nutzt **nicht** `process.env.GH_TOKEN`.
- **AC6** — Der `GH_TOKEN`/`GITHUB_TOKEN`-PAT ist **kein** regulärer Lese-Mechanismus mehr: `docker-compose.yml` reicht `GH_TOKEN` nicht mehr als für den `GitHubReader` benötigten Wert durch, und `.env.example` bewirbt ihn nicht mehr als primären Weg für `/api/status`/Repo-Übersicht. Der gh-CLI-Auth-Pfad (`ensure-gh-auth.sh`) und das `unset GH_TOKEN/GITHUB_TOKEN` im `docker-entrypoint.sh` bleiben funktional unverändert (testbar: das Unset bleibt im Entrypoint stehen).
- **AC7** — **Graceful degradation:** Sind die github-Katalog-Felder unvollständig/nicht gesetzt oder schlägt der Mint fehl, wirft `getToken()` einen `GitHubAppTokenError` (passender `.code`), der `GitHubReader` fängt ihn und liefert leere Liste/„unknown" (kein Crash); der Server-Start ist davon **nicht** betroffen (testbar: Reader-Aufruf ohne Creds wirft nicht nach außen).
- **AC8** — **Token-Floor (hart):** Das Installation-Token erscheint **nie** in einer HTTP-Response, einem Log, dem Audit, dem WS-Stream, einer URL/Query oder Argv. Provider-/Reader-Fehlermeldungen enthalten **keinen** Token- oder Private-Key-Wert (testbar: Fehler-`message` und Logs enthalten den Token-String nicht; nur Feldnamen/Codes). Der bestehende Security-Floor von `githubAppToken.js` gilt unverändert weiter.

### Env-Fallback im Reader vollständig entfernt (S-149)
- **AC9** — **Kein `process.env.GH_TOKEN`-Default im `GitHubReader` mehr:** Der Konstruktor-Default `() => process.env.GH_TOKEN` ist **entfernt**. Wird der Reader **ohne** `tokenProvider` konstruiert, resolved er **kein** Token (Token bleibt `undefined`) — er greift **nicht** auf `process.env.GH_TOKEN` (oder `GITHUB_TOKEN`) zurück. (Testbar: Reader **ohne** `tokenProvider`, aber **mit gesetztem** `process.env.GH_TOKEN`, ruft `getProjects()`/`listRepos()` ⇒ liefert **leere Liste**/„unknown" und nutzt das Env-Token nicht; ein injizierter `fetchFn` sieht **keinen** `Authorization: Bearer`-Header aus dem Env-Token.)
- **AC10** — **Graceful bei leerem/fehlendem Provider-Token (DR-Fall):** Liefert der injizierte `tokenProvider` kein/leeres Token (z.B. leerer CredentialStore beim DR-Restore), während `process.env.GH_TOKEN` gesetzt ist, degeneriert der Reader auf leere Liste/„unknown" — er fällt **nicht** auf das Env-`GH_TOKEN` zurück und crasht nicht. (Testbar: `tokenProvider` → `undefined` + `process.env.GH_TOKEN` gesetzt ⇒ `getProjects()`/`listRepos()` liefern leer/„unknown", kein Repo wird über das Env-Token gelesen.) Der gh-CLI-Auth-Pfad (`ensure-gh-auth.sh`, Entrypoint-Minting von `GH_TOKEN`) bleibt davon **unberührt** (AC6/§8).

## Verträge
> Sprach-neutral; konkrete Klassen/Dateien sind Hinweise, der Vertrag ist das Verhalten.

- **`GitHubAppTokenProvider`** (Boundary): Konstruktion mit `{ credentialStore, mintFn?, now? }` (injizierbarer Mint + Clock für Tests). Methode `getToken(): Promise<string>` — liefert ein gültiges Installation-Token; intern Cache + in-flight-Promise + Safety-Margin.
- **`GitHubReader`** (`src/GitHubReader.js`): unverändert ein `{ tokenProvider }`-Vertrag (`() => string|Promise<string>`); in `server.js` mit `() => provider.getToken()` verdrahtet. Reader bleibt **read-only** (kein mutierender GitHub-Aufruf).
- **Konfiguration:** `docker-compose.yml` / `.env.example` bilden das App-only-Default-Modell ab; github-App-Creds kommen store-intern aus dem `CredentialStore`-Schema `github` (`credentials/github/app_id`, `…/installation_id`, `…/private_key`). Kein PAT als regulärer Lese-Credential.
- **Fehlervertrag:** `GitHubAppTokenError` mit `.code ∈ {credentials-incomplete, jwt-sign-failed, network-error, invalid-response}` (bestehende Codes, wiederverwendet); `message` secret-frei.

## Edge-Cases & Fehlerverhalten
- **Parallele erste Last** (Cold-Cache, viele gleichzeitige `/api/status`-Reads) → ein einziger Mint, alle teilen das Ergebnis (AC4).
- **Mint schlägt fehl** (Netz/Permission) → in-flight-Promise verworfen; nächster Aufruf versucht erneut; Reader degeneriert in der Zwischenzeit auf „unbekannt"/leere Liste, ohne den Server zu blockieren (AC7).
- **Creds unvollständig** → `credentials-incomplete`, secret-frei; Reader-Lesen liefert leere Liste; Schreibpfade ([[github-repo-create]]) melden weiterhin ihren eigenen klaren Fehler (unverändert).
- **Stale-`GH_TOKEN`-Env** (z.B. abgelaufener `ghs_…` aus altem `docker-run`) → wird nicht mehr als Lese-Pfad herangezogen; das bestehende Entrypoint-`unset` bleibt als Schutz für die gh-CLI-Auth erhalten (AC6).
- **Provider ohne `credentialStore`** konstruiert → `getToken()` wirft `credentials-incomplete` (delegiert an `mintInstallationToken`), kein Crash beim Konstruieren.

## NFRs
- **Sicherheit (Floor, hart):** Installation-Token niemals in Frontend-Bundle, Logs, Audit, WS-Stream, Response oder URL/Query/Argv (AC8). Das **gecachte** Token lebt ausschließlich in-memory im Provider-Boundary, nie persistiert, nie in eine credential-frei nach außen gegebene URL gespiegelt.
- **Konventionen:** ESM, async/await; typisierte Fehler über `.code` (nicht über Message-Strings) verzweigt.
- **Performance:** Cache + Single-Flight reduzieren GitHub-API-Token-Mints auf ~1 pro ~50 min statt einem pro Lese-Aggregation; eine langsame/fehlende Token-Quelle blockiert die Reader-Degradierung nicht (Reader bleibt graceful).
- **Betrieb:** Voraussetzung ist ein vollständiges `CredentialStore`-Schema `github`; der App-only-Default ist in `.env.example`/`docker-compose.yml` dokumentiert.

## Nicht-Ziele
- Änderung des **Schreib**-Token-Pfads (`GitHubWriter`/`GitHubCloner`/`WorkspaceMutator`): die schreibenden Pfade minten weiterhin **transient unmittelbar vor** dem Aufruf (bewusst **nicht** über den gecachten Provider, um den „transient pro Mutation"-Floor aus [[github-repo-create]] nicht aufzuweichen). Ob die Schreibpfade später optional denselben Provider nutzen, ist eine separate Folge-Anforderung.
- Änderung des gh-CLI-Auth-Pfads (`ensure-gh-auth.sh`) oder des Container-Bootstraps darüber hinaus.
- Caching von Schreib-Tokens / Provider-Persistenz über Prozessneustarts hinaus.
- Token-Rotation/Revocation-Webhooks.

## Abhängigkeiten
- [[github-repo-create]] (`src/githubAppToken.js` — `mintInstallationToken`, `GitHubAppTokenError`; bleibt die kanonische Mint-Implementierung, die der Provider kapselt).
- [[factory-status]] / [[github-repos-overview]] (`GitHubReader`-Konsumenten; profitieren transparent von der Auth-Vereinheitlichung).
- [[settings-credentials]] / `CredentialStore` (Schema `github`).
- **Architektur:** neuer `GitHubAppTokenProvider`-Boundary neben `GitHubReader`/`GitHubWriter`; Detail (Cache-Datenstruktur, Clock-Injection) = `coder`/`architekt`.
