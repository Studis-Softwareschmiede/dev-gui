---
title: Stop einer Hetzner-Maschine, die die Aktion nicht unterstützt, führt zu klarer „nicht unterstützt“-Meldung statt Fehler
target: ephemeral-infra
kosten: keine zusätzliche Infra — prüft nur die UI-Darstellung anhand des Capability-Flags einer bestehenden/gelisteten Maschine
quell_specs:
  - docs/specs/view-vps.md
  - docs/specs/vps-provider-boundary.md
---

# VPS — Stop-Aktion bei fehlender Capability

Test-Begleitbeschreibung für `vps-stop-unsupported-capability.spec.ts`.

## target

`target: ephemeral-infra` ([[regression-runner]] AC2/AC4): kein eigenes
Provisionieren — der Test prüft nur, dass eine Maschine ohne Stop-Capability in
der UI klar als nicht unterstützt markiert ist, statt einen Fehleraufruf zu
provozieren.

## Übersicht

Deckt `docs/specs/view-vps.md` AC6 und `docs/specs/vps-provider-boundary.md` AC6:
eine Lifecycle-Aktion, die der Provider laut Capability-Flag nicht unterstützt,
wird deaktiviert/als „nicht unterstützt“ dargestellt, nicht als Fehleraufruf.

## Testfälle

- **Stop-Button bei `capability_stop: false`**: iteriert über
  `vps-stop-unsupported-capability.data.json`.

## Verdrahtet mit

- Testdatei: `vps-stop-unsupported-capability.spec.ts`
- Datentabelle: `vps-stop-unsupported-capability.data.json`
- Reporter: CTRF-JSON + JUnit (via `playwright.config.ts`)
