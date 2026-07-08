---
title: Hetzner-Server anlegen und in der Übersicht als laufend erkennen
target: ephemeral-infra
kosten: gering — ein einzelner rtest-*-Hetzner-Server (cx22, nbg1) für die Dauer des Testlaufs; wird im Teardown wieder gestoppt/abgebaut
quell_specs:
  - docs/specs/view-vps.md
  - docs/specs/vps-provider-boundary.md
---

# VPS — Hetzner-Server anlegen und als laufend erkennen

Test-Begleitbeschreibung für `vps-create-and-running.spec.ts`.

## target

`target: ephemeral-infra` ([[regression-runner]] AC2/AC4): der Test provisioniert
einen echten, wegwerfbaren Hetzner-Server über das Create-Formular der VPS-Ansicht
und baut ihn im Teardown garantiert wieder ab
([[regression-playwright-conventions]] AC4). Der Regressions-Runner führt diese
Suite ohne lokalen Erreichbarkeits-Check aus.

## Übersicht

Deckt den Main-Success-Flow aus `docs/specs/view-vps.md` (AC3, AC7, AC9) und
`docs/specs/vps-provider-boundary.md` (AC7, AC8): Server über das Create-Formular
anlegen (Provider, Name, Region, Servertyp, Image, SSH-Key-Label je Rolle
`root`/`alex`), Erfolgsmeldung abwarten, Übersicht pollen bis Status `running`.

## Testfälle

- **Create + Polling bis running**: iteriert über `vps-create-and-running.data.json`
  (aktuell ein Datensatz `regression-test-vps`, Provider `hetzner`).

## Secrets

Das Hetzner-API-Token wird **nicht** aus dieser Suite gelesen — es wird zur
Laufzeit über den Credential-Store injiziert (`process.env.HETZNER_API_TOKEN`,
[[regression-runner]] AC9, `scripts/load-env.sh`). Die Testdatentabelle enthält
ausschließlich SSH-Key-**Labels** (`root-default`, `alex-default`), keine
Schlüsselmaterialien oder Tokens.

## Ressourcen-Namensschema

Der angelegte Test-Server trägt den Präfix `rtest-` (`rtest-regression-test-vps`) —
[[regression-runner]] AC7. Teardown (Stop) läuft im `finally`-Block, auch bei
Testfehlschlag ([[regression-playwright-conventions]] AC4).

## Verdrahtet mit

- Testdatei: `vps-create-and-running.spec.ts`
- Datentabelle: `vps-create-and-running.data.json`
- Reporter: CTRF-JSON + JUnit (via `playwright.config.ts`)
