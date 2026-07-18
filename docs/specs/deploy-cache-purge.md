---
id: deploy-cache-purge
title: Cloudflare-Edge-Cache-Purge nach jedem Deploy (Saga-Abschlussschritt)
status: active
area: deployment
version: 1
spec_format: use-case-2.0
---

# Spec: Cloudflare-Edge-Cache-Purge nach jedem Deploy (`deploy-cache-purge`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (hartes Drift-Gate). Security-kritisch (Cloudflare-Mutation mit dem bestehenden Cloudflare-API-Token).
> Boundary fixiert in **ADR-010** (`CloudflareApi` — einziger Ort, der `api.cloudflare.com` anspricht) + **ADR-012** (`DeployOrchestrator` — atomare Container+Route-Einheit). Konsumiert/erweitert die Deploy-Saga aus [[deploy-lifecycle]] (AC3) — **keine** zweite Deploy-Implementierung, **kein** Umschreiben von [[deploy-lifecycle]].

## Zweck
Nach einem erfolgreichen Deploy (Container neu aufgebaut, Route + DNS gesetzt) leert dev-gui den **Cloudflare-Edge-Cache** für den betroffenen Hostname, damit Nutzer sofort die neue Version der Oberfläche sehen. Ohne diesen Schritt liefert Cloudflare gecachte statische Frontend-Bundles (z.B. `main.dart.js`, `cache-control: max-age=14400` = 4 h, `cf-cache-status: HIT`) bis zu **4 Stunden** aus der Edge weiter — auch inkognito (Edge-Cache, kein Browser-Cache) — während das Backend bereits die neue Version ist. Der Versionsstempel im Frontend weicht dann von `GET /version` ab (empirisch belegt, App flashrescue, 2026-07-18).

> **Abgrenzung:** Diese Spec liefert **den Purge-Schritt + die neue `CloudflareApi`-Methode**. Die **Deploy-Saga selbst** (Gates → pull → replace → run → Route/DNS) lebt in [[deploy-lifecycle]] und wird **wiederverwendet**, nicht dupliziert. Der Purge ist ein **best-effort Abschlussschritt** dieser Saga.

## Verhalten

### Platzierung in der Saga
1. Der Purge läuft im **`DeployOrchestrator`** ([[deploy-lifecycle]]) **genau einmal pro Deploy**, **nach** dem erfolgreichen Route- **und** DNS-CNAME-Schritt (Container läuft, Route + DNS gesetzt) und **unmittelbar vor** der Erfolgsmeldung `{ result: "ok", deployment }`. Er läuft **nicht** vor dem Recreate und **nicht**, wenn ein vorheriger Saga-Schritt (Gate/pull/run/Route/DNS) fehlgeschlagen ist — ein fehlgeschlagener Deploy purged nicht.
2. Der Purge nutzt den **bereits in der Saga aufgelösten** `zoneId` (Longest-Suffix-Match aus `resolveZoneForHostname`, [[deploy-lifecycle]]) und den `hostname` — es wird **keine** zweite Zone-Auflösung eingeführt und **kein** neuer Endpunkt.

### Purge-Aufruf
3. Der Purge geschieht über eine **neue Methode `CloudflareApi.purgeCache(zoneId, hostname)`** in der **einzigen** Cloudflare-Boundary (`CloudflareApi`, ADR-010) — kein anderes Modul spricht `api.cloudflare.com` an.
4. **Hostname-scoped bevorzugt:** `POST https://api.cloudflare.com/client/v4/zones/{zoneId}/purge_cache` mit `Authorization: Bearer <token>` und Body `{"hosts":["<hostname>"]}`. Damit werden **nur** die Objekte dieses Hostnames verworfen — andere Apps derselben Zone bleiben unberührt.
5. **Fallback `purge_everything`:** schlägt der hostname-scoped Purge mit einem Cloudflare-Fehler fehl, der auf Nichtunterstützung von `hosts` hindeutet (z.B. Plan ohne hostname-scoped Purge), wird **einmalig** auf `{"purge_everything":true}` derselben Zone zurückgefallen. `purge_everything` ist **nur** Fallback, nie der Standardpfad.

### Best-effort (kein Deploy-Blocker)
6. Der Purge ist **best-effort**: ein Fehler (API down, Rate-Limit, Timeout, Fallback ebenfalls fehlgeschlagen) lässt den **Deploy nicht fehlschlagen** — die Saga endet weiterhin mit `{ result: "ok", deployment }`. Der Fehler wird als **sichtbare Warnung mit Retry-Hinweis** im Deploy-Ergebnis/Report vermerkt (secret-frei) und auditiert.
7. **Erfolg + Fehler werden klar geloggt/auditiert** (secret-frei): welcher Hostname, welche Zone, welcher Modus (`hosts` | `purge_everything`), Ergebnis (ok | Fehler mit Fehlerklasse). **Kein** Cloudflare-Token erscheint je in Response, Logs, Audit, `ReconcileNotice`, WS-Stream, Argv oder Frontend-Bundle.

### Nicht-Cloudflare-Deploys übersprungen (pro App abschaltbar)
8. Der Purge läuft **ausschließlich** im tunnel-route-basierten Deploy-Pfad (`DeployOrchestrator`), in dem per Definition immer eine Cloudflare-Route + Zone existiert. Ist Cloudflare **nicht konfiguriert** (kein Token/Account-Id → `cloudflare-not-configured`) oder lässt sich **kein `zoneId`** für den Hostname auflösen, wird der Purge **übersprungen** (no-op, **kein** Fehler, **kein** API-Call). So greift der Purge nur, wenn die App tatsächlich hinter Cloudflare liegt.
9. Der **lokale dev-gui-Selbst-Rollout** (`docker compose`, `StackDeployOrchestrator`, ohne Cloudflare) durchläuft diese Saga **nicht** und ist damit **nicht betroffen** — kein Purge, kein no-op-Aufruf.

### Wiederverwendung durch Update- und VPS-Pfad
10. Der **Container-Image-Update-Pfad** ([[container-image-update]], F-080/F-082) und der **VPS-Rollout** **konsumieren dieselbe `DeployOrchestrator`-Saga** ([[deploy-lifecycle]] AC3). Sie erhalten den Purge damit **automatisch mit** — **ohne** eigenen Purge-Code. Ein Image-Update eines managed Containers leert den Edge-Cache seines Hostnames genauso wie ein Erst-Deploy.

## Acceptance-Kriterien

- **AC1** — Es existiert **genau eine** Methode `CloudflareApi.purgeCache(zoneId, hostname)` in `src/cloudflare/CloudflareApi.js`; kein anderes Modul ruft `…/purge_cache` bzw. `api.cloudflare.com` für den Purge auf (Grep-prüfbar, ADR-010). Der Token wird store-intern per Aufruf aus `credentials/cloudflare/api_token` bezogen und **nur** im `Authorization: Bearer`-Header gesendet.
- **AC2** — `purgeCache(zoneId, hostname)` sendet `POST /client/v4/zones/{zoneId}/purge_cache` mit Body `{"hosts":["<hostname>"]}` (hostname-scoped, bevorzugt). Testbar mit fetch-Mock: korrekte URL, Methode, Header, Body.
- **AC3** — Schlägt der hostname-scoped Purge mit einem Cloudflare-Fehler fehl, der `hosts` als nicht unterstützt kennzeichnet, fällt `purgeCache` **einmalig** auf Body `{"purge_everything":true}` derselben Zone zurück. `purge_everything` wird **nie** ohne vorherigen `hosts`-Versuch gesendet. Testbar: `hosts`-Fehler-Mock → zweiter Call mit `purge_everything`.
- **AC4** — Der `DeployOrchestrator` ruft `purgeCache(zoneId, hostname)` **genau einmal** pro Deploy auf, **nach** erfolgreichem Route- **und** DNS-Schritt und **vor** dem Return `{ result: "ok", deployment }`. Testbar: Erfolgs-Deploy → `purgeCache` wird nach `addRoute`/`createDnsRecord` und vor der Erfolgsmeldung genau einmal aufgerufen (Aufruf-Reihenfolge im Saga-Test).
- **AC5** — Schlägt ein Saga-Schritt **vor** dem Purge fehl (Gate, `pull`, `run`, Route oder DNS → `{ result: "error" }` oder Rollback greift, AC4/AC18 [[deploy-lifecycle]]), wird `purgeCache` **nicht** aufgerufen. Testbar: Route-Fehler-Mock → **kein** `purgeCache`-Call.
- **AC6** — Der Purge ist **best-effort**: wirft/fehlschlägt `purgeCache` (API-Fehler, Timeout, Rate-Limit, auch der `purge_everything`-Fallback), bleibt das Deploy-Ergebnis `{ result: "ok", deployment }`. Das `deployment`-Read-Model trägt ein sichtbares, secret-freies Feld (z.B. `cachePurge: { status: "ok" | "failed" | "skipped", mode?: "hosts" | "purge_everything", warning? }`) mit Retry-Hinweis bei `failed`. Testbar: Purge-Fehler-Mock → `result: "ok"`, `deployment.cachePurge.status === "failed"` mit Warnung.
- **AC7** — Ist Cloudflare **nicht konfiguriert** (`cloudflare-not-configured`) oder kann **kein `zoneId`** aufgelöst werden, wird der Purge **übersprungen**: **kein** `…/purge_cache`-Call, **kein** Fehler, `deployment.cachePurge.status === "skipped"`. Testbar: nicht-konfigurierter `CloudflareApi`-Mock → kein Purge-Call, Deploy bleibt `ok`.
- **AC8** (Security/Floor) — **Kein** Cloudflare-Token erscheint je in Response, Logs, Audit, `ReconcileNotice`, WS-Stream, Argv oder Frontend-Bundle. Erfolg **und** Fehler des Purge werden secret-frei protokolliert/auditiert (Hostname, Zone-Id, Modus, Ergebnis/Fehlerklasse). Grep-prüfbar: keine Token-Interpolation in Log-/Audit-/Response-Pfade.
  - **Konsistenz-Nachzug (S-372):** „auditiert" heißt **persistent** über `auditStore.record(...)` — nicht nur `console.log`/`console.warn`. Der `DeployOrchestrator` selbst bleibt **audit-frei** (Bestands-Muster, vgl. [[vps-tunnel-existence-gate]] AC13); beide Aufrufer-Router (`deploymentsRouter.js` Erst-Deploy, `vpsContainerRouter.js` `/update`) schreiben je einen Audit-Eintrag `deploy-cache-purge:<hostname>:<status>:<mode-oder-errorClass>` für `deployment.cachePurge.status === "ok" | "failed"`. Der `skipped`-Ausgang (AC7) erzeugt bewusst **keinen** Audit-Eintrag — kein API-Call, kein Vorgang (analog anderen No-op-Skips im Deploy-Pfad); die AC8-Formulierung nennt hier wörtlich nur „Erfolg und Fehler". `zoneId` bleibt Saga-intern (nicht Bestandteil von `deployment.cachePurge`) und wird bereits über das bestehende `console.log`/`console.warn` secret-frei protokolliert.

## Verträge

### Neue Methode `CloudflareApi.purgeCache(zoneId, hostname)`
- **Input:** `zoneId: string` (bereits aufgelöst), `hostname: string`.
- **Verhalten:** POST an `${CF_BASE}/zones/{zoneId}/purge_cache`, `Authorization: Bearer <token>` (store-intern), per-request AbortController-Timeout (ADR-010-Linie). Body zunächst `{"hosts":["<hostname>"]}`; bei `hosts`-Nichtunterstützung Fallback `{"purge_everything":true}`.
- **Output:** `{ result: "ok", mode: "hosts" | "purge_everything" }` bei Erfolg; `{ result: "skipped", reason: "cloudflare-not-configured" }` wenn kein Token; `{ result: "error", errorClass, reason }` (secret-frei) bei endgültigem Fehler. Die Methode **wirft nicht** in den Saga-Aufrufer durch (best-effort) — oder der Aufrufer fängt konsequent (Implementierungsdetail des `coder`, solange AC6 erfüllt ist).

### Erweiterung Deploy-Ergebnis
- `deployment.cachePurge = { status: "ok" | "failed" | "skipped", mode?: "hosts" | "purge_everything", warning?: string, errorClass?: string }` — sichtbar, secret-frei. `errorClass` (S-372) ist nur bei `status === "failed"` gesetzt (dasselbe generische Klassifikations-Label wie im `warning`-Text) und dient dem aufrufenden Router als Audit-Feld (siehe AC8-Nachzug oben).

## Edge-Cases & Fehlerverhalten
- **Cloudflare nicht konfiguriert** → Purge übersprungen (`skipped`), kein API-Call, Deploy `ok` (AC7).
- **`zoneId` nicht auflösbar** (Longest-Suffix-Match liefert null) → übersprungen, wie AC7. (In der regulären Saga ist der `zoneId` bereits gesetzt, da der Deploy sonst vorher abgebrochen wäre — dieser Fall ist ein defensiver No-op.)
- **Plan ohne hostname-scoped Purge:** hostname-scoped `hosts`-Purge ist Cloudflare-plan-abhängig (typischerweise Enterprise). Antwortet die API mit dem entsprechenden Fehler, greift der `purge_everything`-Fallback (AC3). Schlägt auch dieser fehl → `failed` best-effort (AC6).
- **Rate-Limit / API down / Timeout** → `failed`, best-effort, Deploy bleibt `ok`, Warnung mit Retry-Hinweis (AC6).
- **Idempotenz:** ein zweiter Deploy löst einen zweiten Purge aus (gewollt — jede neue Version braucht eine frische Edge). Innerhalb **eines** Deploys wird `purgeCache` **genau einmal** aufgerufen (AC4), auch wenn `hosts` + Fallback zwei HTTP-Calls bedeuten.

## NFRs
- **Security (Floor):** Token store-intern, nur im Bearer-Header; nie in Response/Log/Audit/WS/Argv/Frontend (AC8). Cloudflare-Mutation läuft über die einzige Boundary (ADR-010).
- **Verfügbarkeit:** best-effort — der Purge darf einen erfolgreichen Deploy nie in einen Fehler kippen (AC6). Der Purge-Timeout ist entkoppelt (per-request AbortController) und blockiert die Saga nicht unbegrenzt.

## Nicht-Ziele
- **Kein** per-App-Konfig-Schalter/Toggle für den Purge (Resolution R4): der Purge greift strukturell nur im Cloudflare-fronted Deploy-Pfad; nicht-Cloudflare-Apps (compose-Selbst-Rollout) durchlaufen die Saga nicht. Ein expliziter Opt-out-Schalter je App ist ein eigenes Vorhaben, falls je gewünscht.
- **Kein** dedizierter post-run Health-/`GET /version`-Abgleich vor dem Purge (Resolution R2): die Saga betrachtet den Deploy nach Route + DNS als erfolgreich; ein zusätzliches Versions-Diff (Frontend-Stempel == `GET /version`) als Purge-Vorbedingung ist bewusst ausgeklammert.
- **Kein** Purge per einzelner URL/Tag/Prefix — nur hostname-scoped `hosts` mit `purge_everything`-Fallback (Owner-Vorgabe).
- **Kein** Umschreiben von [[deploy-lifecycle]] (die Saga-Kern-ACs bleiben unverändert; diese Spec fügt nur den Abschlussschritt hinzu).

## Abhängigkeiten
- [[deploy-lifecycle]] (die konsumierte Saga; Purge ist deren Abschlussschritt nach AC3).
- [[container-image-update]] (konsumiert dieselbe Saga → erhält den Purge automatisch).
- [[cloudflare-reconciliation]] (teilt die `CloudflareApi`-Boundary + Token-Katalog).
- Externer Dienst: Cloudflare API (`api.cloudflare.com`), `credentials/cloudflare/api_token`.

---

## Resolutions (Subagent-Lauf 2026-07-18, ohne Owner-Rückfrage konservativ entschieden)

> Dieser Lauf lief als **Subagent** (kein `AskUserQuestion`, kein `Task`/estimator). Verbleibende Ausgestaltungsfragen sind fail-safe entschieden und hier verankert — sichtbar + billig umkehrbar.

- **R1 (Spec-Schnitt):** **Neue** Spec statt ACs in [[deploy-lifecycle]] ergänzen — konsistent mit dem Repo-Muster, in dem [[cloudflare-reconciliation]] und [[container-image-update]] als **eigene** Specs die Deploy-Saga konsumieren, ohne [[deploy-lifecycle]] umzuschreiben. Soll der Purge stattdessen als v4-AC direkt in [[deploy-lifecycle]] wandern, ist das eine bewusste Umentscheidung — dann entfällt diese Spec.
- **R2 (Platzierung):** Der Purge sitzt am **einzigen Erfolgsausgang** von `DeployOrchestrator.deploy()` — nach Route + DNS, vor `{ result: "ok" }`. Die „Readiness-Probe" der bestehenden Saga ist ein **Vor-pull-VPS-Provisioning-Gate**, kein post-run Health-Check; ein zusätzlicher post-run Health-/Versions-Abgleich vor dem Purge ist bewusst ausgeklammert (Nicht-Ziele). Ist ein echter post-run Health-Gate vor dem Purge gewünscht, ist das ein Folge-Item.
- **R3 (hosts vs. purge_everything + Plan-Caveat):** hostname-scoped `hosts`-Purge ist plan-abhängig (i.d.R. Enterprise). Umgesetzt als: `hosts` zuerst → bei `hosts`-Nichtunterstützung Fallback `purge_everything` (Owner-sanktioniert) → sonst best-effort `failed`. Genau die Owner-Vorgabe, plus definierter Fallback-Trigger.
- **R4 (Abschaltbarkeit):** Strukturell gelöst — nur der tunnel-route-Deploy-Pfad purged; nicht-Cloudflare-Apps (compose-Selbst-Rollout) durchlaufen die Saga nicht. **Kein** neuer per-App-Toggle/Store eingeführt (weniger autonome Mutation). Ein expliziter Opt-out-Schalter je App wäre ein eigenes Vorhaben.
</content>
</invoke>
