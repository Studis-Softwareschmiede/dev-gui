# Lessons: cicd (projekt-lokal, dev-gui)

> Newest-first. Nur systemische, wiederkehrende Infra-/Deploy-/CI-Befunde — kein Write-back pro Lauf.

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
