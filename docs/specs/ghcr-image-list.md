---
id: ghcr-image-list
title: GHCR-Image-Liste — verfügbare Org-Container-Images + Tags aus GitHub Packages (Backend)
status: draft
version: 1
---

# Spec: GHCR-Image-Liste (`ghcr-image-list`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Read-only, hinter Access; nutzt das bestehende GitHub-App-Token ([[github-app-token-unification]], S-146) — **kein** neues Credential.

## Zweck
**Paket ② Deployment-Flow, Backend-Bausteine:** dev-gui macht die in der GitHub-Container-Registry (**ghcr**) veröffentlichten Container-Images der Org maschinen-lesbar verfügbar — eine **Liste der Image-Pakete** und je Image die **Tags/Versionen**. Damit kann das Deployment-Menü ([[deploy-lifecycle]], S-155) ein Image und einen Tag per Dropdown anbieten, statt eine Image-Referenz frei eintippen zu lassen. Diese Spec liefert **nur die Lese-Endpunkte** (keine UI, kein Deploy).

## Verhalten
1. Der einzige Ort, der die GitHub-API anspricht, bleibt der GitHub-Reader-Boundary (analog [[github-repos-overview]]); das Token kommt **ausschließlich** über den injizierten App-Token-Provider (`() => getToken()`, S-146 AC5). Es gibt **keinen** `process.env.GH_TOKEN`-Fallback ([[github-app-token-unification]] AC9).
2. **Image-Pakete listen:** Das Backend liest die Container-Pakete der Org über `GET /orgs/{org}/packages?package_type=container` (paginiert) und liefert je Paket einen normalisierten Eintrag `{ name, fullImageRef, visibility, htmlUrl, updatedAt }`. `fullImageRef` ist die vollständige ghcr-Referenz **ohne** Tag (z.B. `ghcr.io/studis-softwareschmiede/<name>`).
3. **Tags/Versionen eines Image listen:** Das Backend liest die Versionen eines Pakets über `GET /orgs/{org}/packages/container/{package_name}/versions` (paginiert) und liefert je Version die enthaltenen **Tags** sowie Metadaten `{ tags: string[], digest, updatedAt }`. Versionen **ohne** Tag (nur Digest) werden als solche kenntlich gemacht (siehe Edge-Cases), nicht stillschweigend verworfen.
4. **Org** ist die feste dev-gui-Org (`Studis-Softwareschmiede`), wie im bestehenden Reader (keine Org als Nutzereingabe → kein SSRF, security/R05).
5. **Graceful Degradation:** Ist GitHub nicht erreichbar, das Token nicht auflösbar oder die Packages-API liefert einen Fehler, antwortet der Endpunkt mit einer **leeren Liste** und optionalem `errors`-Feld — **kein** Crash, **kein** 5xx-Sturz, **kein** Token-Leak (analog [[github-repos-overview]] AC6).
6. **Sortierung:** Image-Pakete und Tags werden deterministisch sortiert (Images alphabetisch nach `name`; Tags nach `updatedAt` absteigend, sodass der neueste Tag oben steht) — damit das Dropdown stabil und vorhersehbar ist.

## Acceptance-Kriterien

### Boundary & Token
- **AC1** — Der Zugriff auf die GitHub-Packages-API erfolgt **ausschließlich** über den GitHub-Reader-Boundary (Grep-prüfbar: kein zweiter Ort spricht `api.github.com/.../packages` an); das Token wird **ausschließlich** über den injizierten App-Token-Provider bezogen. Es existiert **kein** `process.env.GH_TOKEN`-Pfad in diesem Code.

### Image-Liste
- **AC2** — `GET /api/github/packages` liefert `{ packages: ImagePackage[] }` (immer 200). Jeder Eintrag hat `{ name, fullImageRef, visibility, htmlUrl, updatedAt }`; `fullImageRef` ist `ghcr.io/<org>/<name>` (kleingeschrieben, **ohne** Tag). Die Liste enthält genau die Container-Pakete der Org aus `GET /orgs/{org}/packages?package_type=container` (paginiert vollständig eingesammelt).
- **AC3** — `GET /api/github/packages/{name}/tags` liefert `{ tags: ImageTag[] }` (immer 200) mit je `{ tag, digest, updatedAt }` aus `GET /orgs/{org}/packages/container/{name}/versions`; eine Version mit mehreren Tags erzeugt **je Tag** einen Eintrag. Tags sind nach `updatedAt` absteigend sortiert.

### Sicherheit & Degradation (Floor)
- **AC4** — Beide Endpunkte liegen hinter der Access-Mauer (`/api/*`-AccessGuard); sie sind **read-only** (kein POST/PATCH/PUT/DELETE). Das App-Token erscheint **nie** in Response, Log, Fehlertext oder WS-Stream (security/R01).
- **AC5** — Bei GitHub-Unerreichbarkeit / fehlendem Token / API-Fehler degradiert jeder Endpunkt zu einer **leeren Liste** (`{ packages: [] }` bzw. `{ tags: [] }`) mit Status 200; optional ein `errors: [{ scope, errorClass }]`-Feld ohne sensible Details. Der `{name}`-Parameter wird validiert (nur Paketnamen-Zeichensatz, kein Pfad-/Injection-Zeichen) — ungültig → 400, kein API-Call.

## Verträge
> Token-/Boundary-Detail in [[github-app-token-unification]] (ADR-007-Linie); Reader-Muster analog [[github-repos-overview]].

- **`ImagePackage`:** `{ name: string, fullImageRef: string, visibility: "public"|"private"|"internal", htmlUrl: string, updatedAt: string }`. `fullImageRef = "ghcr.io/" + org.toLowerCase() + "/" + name.toLowerCase()`.
- **`ImageTag`:** `{ tag: string, digest: string, updatedAt: string }`.
- **GET `/api/github/packages`** → `200 { packages: ImagePackage[], errors?: [{ scope, errorClass }] }`.
- **GET `/api/github/packages/{name}/tags`** → `200 { tags: ImageTag[], errors?: [{ scope, errorClass }] }`; `400 { error }` bei ungültigem `name`.
- **Upstream-GitHub-Endpunkte (read):** `GET /orgs/{org}/packages?package_type=container&per_page=100` (paginiert via `Link`-Header), `GET /orgs/{org}/packages/container/{name}/versions?per_page=100` (paginiert). Jeder externe Fetch mit Timeout (js/R03).
- **Org:** fest = `Studis-Softwareschmiede` (Konstante im Reader, keine Nutzereingabe).
- **`name`-Validierung:** `^[A-Za-z0-9._-]+$` (Paketnamen-Zeichensatz; Slashes für verschachtelte Pfade werden URL-encoded, falls die Org sie nutzt — kein Injection-Pfad).

## Edge-Cases & Fehlerverhalten
- Token nicht auflösbar (Provider gibt `undefined`) → leere Liste, 200 (AC5).
- GitHub 401/403 (App-Berechtigung fehlt für `packages:read`) → leere Liste + `errors`, 200; **kein** Token-Leak in der Fehlermeldung.
- Paginierung: mehr als 100 Pakete/Versionen → alle Seiten via `Link`-Header eingesammelt; Abbruch nach sinnvollem Seiten-Limit (DoS-Schutz), Rest degradiert.
- Version ohne Tag (nur Digest, z.B. Zwischen-Layer) → **kein** `ImageTag`-Eintrag mit leerem `tag`; entweder ausgelassen oder mit explizitem Marker (`tag: "<untagged>"`) — `coder` finalisiert, Default-Empfehlung: untagged-Versionen werden ausgelassen (für ein Deploy-Dropdown unbrauchbar).
- Unbekannter/nicht existierender `{name}` → GitHub 404 → leere `tags`-Liste + `errors`, 200 (keine Existenz-Auskunft per 404 nötig).

## NFRs
- **Sicherheit (Floor, hart):** read-only, hinter Access; App-Token nie geleakt (Response/Log/WS/Argv); Org fix (kein SSRF); `{name}` validiert.
- **Resilienz:** jeder Fetch mit Timeout; degradiert auf leere Liste statt 5xx.
- **ADR-005-Konformität:** kein Image-Store — Liste **live** aus der Packages-API; kein neues SDK (eingebautes `fetch` über den bestehenden Reader-Boundary).

## Nicht-Ziele
- UI/Dropdowns (→ [[deploy-lifecycle]] / S-155).
- Image-**Build/Push** (ghcr-Image ist Source of Truth, wie im `preview`-Skill).
- Image-**Löschen** in ghcr / Retention.
- Tag-übergreifende Schwachstellen-/Signatur-Prüfung.

## Abhängigkeiten
- [[github-app-token-unification]] (App-Token-Provider, S-146 — Token-Quelle).
- [[github-repos-overview]] (Reader-Boundary-Muster + graceful degradation).
- [[deploy-lifecycle]] (Konsument: Image-/Tag-Dropdowns, S-155).
- [[access-and-guardrails]] (Access-Mauer).
- `docs/architecture.md` — GitHub-Reader-Boundary (einziger GitHub-API-Zugriff), ADR-007 (App-Token).
