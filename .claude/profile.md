# Projekt-Profil (Vorlage: js) — new-project füllt <…> aus
language: js
domains: [security]
build: "npm ci"
test: "npm test"
lint: "npm run lint"
smoke: "curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/"
merge_policy: direct
default_branch: main
board: file
deploy: docker
image: ghcr.io/studis-softwareschmiede/dev-gui
registry: ghcr
container_port: 8080
preview_port: 8080
