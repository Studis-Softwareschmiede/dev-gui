# Lessons: cicd (projekt-lokal, dev-gui)

> Newest-first. Nur systemische, wiederkehrende Infra-/Deploy-/CI-Befunde — kein Write-back pro Lauf.

## cicd/L02 — 2026-07-03: `.claude/profile.md` sagt `deploy: docker`, real läuft dieses Repo über `docker-compose.yml`

**Problem:** `.claude/profile.md` (Zeile `deploy: docker`) suggeriert einen einfachen `docker pull` + `docker rm -f` + `docker run` Rollout (Standard-Pattern A3/`cicd/P06`). Tatsächlich betreibt dev-gui produktiv ein Zwei-Service-Compose-Setup (`docker-compose.yml`, Services `dev-gui` + `socket-proxy`, geteiltes internes Netz `docker-proxy-net`) mit **kritischen benannten Volumes** (`dev-gui-cred` — Credential-Master-Key + `secrets.enc.json`; `dev-gui-claude` — OAuth-Cache/Plugin-Cache) und mehreren Pflicht-Env-Vars (`DOCKER_HOST=tcp://socket-proxy:2375`, `ACCESS_TEAM_DOMAIN`, `GPG_PASSPHRASE`, `DEVGUI_CRED_MASTER_KEY`, `WORKSPACE_DIR`, …).

Ein naiver `docker rm -f dev-gui-dev-gui-1 && docker run -d --name dev-gui-dev-gui-1 -p 8080:8080 "${image}:latest"` (ohne die Compose-Volumes/-Netze/-Envs) hätte einen nackten Container ohne Zugriff auf den Credential-Store, ohne `socket-proxy`-Netz und ohne Access-Guard-Konfiguration erzeugt — Bootstrap-Bruch bzw. stiller Verlust des entsperrten Credential-Stores.

**Korrekte Mechanik:** Vor jedem Rollout `docker-compose.yml`/`docker-compose.override.yml` im Repo-Root prüfen (`ls docker-compose*.yml`). Existiert eine — Rollout ausschließlich über `cicd/P05`:
```bash
docker compose pull dev-gui
docker compose up -d --force-recreate dev-gui
```
Kein `docker rm -f` + `docker run` auf compose-verwaltete Container — das triggert zwar denselben Recreate-Effekt, aber ohne Compose-Kontext (Volumes/Netze/Env aus `docker-compose.yml`) unwiderruflich falsch. `docker image prune -f` bleibt danach unverändert Pflicht (`cicd/F07`).

**Zusatzbeobachtung:** Das Image ist `linux/amd64`, der lokale Docker-Host hier `arm64` (Rosetta-Emulation) — Compose warnt harmlos ("requested image's platform does not match … no specific platform was requested"), der Container startet aber korrekt (Boot-Sequenz inkl. Plugin-Update + gh-Token-Mint dauert dadurch spürbar länger, ca. 30–40s bis der HTTP-Server antwortet — Smoke-Check ggf. mit mehreren Retries statt einmaligem `sleep 2` fahren).

**Bezug:** ergänzt `cicd/P05` (globales Pack) um den konkreten dev-gui-Befund, dass `profile.md`s `deploy: docker` nicht zwangsläufig „kein Compose" bedeutet. Kandidat für Destillation nach global via `retro`.

## cicd/L01 — 2026-07-02: `gh run list --limit 1` direkt nach `git push` liefert oft noch den ALTEN Run

**Problem:** Unmittelbar nach `git push origin main` liefert `gh run list --repo … --branch main --limit 1 --json databaseId --jq '.[0].databaseId'` mit hoher Wahrscheinlichkeit noch den **vorherigen, bereits abgeschlossenen** Run — der neue, durch den Push getriggerte Run ist bei GitHub Actions noch nicht registriert (Webhook-Verzögerung von einigen Sekunden). `gh run watch <alte-run-id> --exit-status` meldet dann sofort "already completed with success" — **obwohl der eigentliche CI-Lauf für den neuen Commit noch gar nicht existiert oder noch läuft**.

**Symptom (beobachtet, item #S-245):** Nach Push von `145cd9a` lieferte `gh run list --limit 1` Run `28614564528` mit `headSha=db72914` (dem VORHERIGEN Commit). `gh run watch` meldete grün, der anschließende `docker pull` + `docker compose up -d --force-recreate` rollte folglich noch das ALTE Image aus (Label `org.opencontainers.image.revision=db72914` statt der erwarteten neuen SHA). Erst ein expliziter `git log` auf den erhaltenen `headSha` deckte die Diskrepanz auf.

**Korrekte Mechanik (Pflicht ab sofort):** Nach dem `gh run list --limit 1`-Aufruf den zurückgelieferten `headSha` GEGEN den eigenen `git rev-parse HEAD` (bzw. den gerade gepushten Commit) abgleichen, BEVOR `gh run watch` als Vertrauensanker für den Rollout gilt:

```bash
NEW_SHA=$(git rev-parse HEAD)
for i in $(seq 1 15); do
  run_json=$(gh run list --repo "$repo" --branch "$default_branch" --limit 1 --json databaseId,headSha)
  run_sha=$(echo "$run_json" | jq -r '.[0].headSha')
  [ "$run_sha" = "$NEW_SHA" ] && break
  sleep 2
done
run_id=$(echo "$run_json" | jq -r '.[0].databaseId')
[ "$run_sha" = "$NEW_SHA" ] || { echo "NEEDS-HUMAN: kein CI-Run für $NEW_SHA gefunden"; exit 1; }
gh run watch "$run_id" --repo "$repo" --exit-status
```

**Zusätzlich beobachtet:** `gh run watch` kann transiente `HTTP 503 Service Unavailable` von der GitHub-API werfen (Annotations-Endpoint oder Run-Status-Endpoint) — das ist KEIN CI-Fehlschlag, sondern ein API-Flakiness. Bei 503 erneut pollen (`gh run view <id> --json status,conclusion`), nicht als CI-FAIL werten.

**Bezug:** verschärft `cicd/F06` (globales Pack) — F06 warnt vor Rollout ohne CI-Watch generell, aber nicht vor der spezifischen Race-Condition, dass `--limit 1` unmittelbar nach dem Push den falschen (alten) Run zurückgibt. Kandidat für Destillation nach global via `retro`.
