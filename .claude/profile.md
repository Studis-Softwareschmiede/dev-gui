# Projekt-Profil (Vorlage: js) — new-project füllt <…> aus
language: js
domains: [security]
build: "npm ci"
test: "npm test"
lint: "npm run lint"
smoke: "curl -fsS -o /dev/null -w '%{http_code}' http://localhost:8080/"
merge_policy: pr
board: 7
deploy: docker
image: ghcr.io/studis-softwareschmiede/dev-gui
registry: ghcr
container_port: 8080
