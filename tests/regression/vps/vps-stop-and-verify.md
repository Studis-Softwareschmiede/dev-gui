---
title: Laufenden Hetzner-Server stoppen und danach kontrollieren, dass er nicht mehr läuft
target: ephemeral-infra
kosten: gering — setzt einen bereits laufenden rtest-*-Hetzner-Server voraus (siehe vps-create-and-running.spec.ts), erzeugt selbst keine zusätzliche Infra
quell_specs:
  - docs/specs/view-vps.md
  - docs/specs/vps-provider-boundary.md
---

# VPS — laufenden Hetzner-Server stoppen und Stop kontrollieren

Test-Begleitbeschreibung für `vps-stop-and-verify.spec.ts`.

## target

`target: ephemeral-infra` ([[regression-runner]] AC2/AC4): der Test setzt einen
zuvor angelegten, laufenden `rtest-*`-Hetzner-Server voraus (typischerweise aus
`vps-create-and-running.spec.ts`) und stoppt ihn über die VPS-Ansicht.

## Übersicht

Deckt `docs/specs/view-vps.md` AC6/AC9 und `docs/specs/vps-provider-boundary.md`
AC5: Stop-Aktion auslösen, klare Rückmeldung (Erfolg/„nicht unterstützt"/Fehler)
statt UI-Absturz, Übersicht pollen bis Status `stopped`.

## Testfälle

- **Stop + Polling bis stopped**: iteriert über `vps-stop-and-verify.data.json`
  (aktuell ein Datensatz `regression-test-vps`, Provider `hetzner`).

## Secrets

Das Hetzner-API-Token wird **nicht** aus dieser Suite gelesen — Laufzeit-Injektion
über den Credential-Store (`process.env.HETZNER_API_TOKEN`, [[regression-runner]]
AC9).

## Verdrahtet mit

- Testdatei: `vps-stop-and-verify.spec.ts`
- Datentabelle: `vps-stop-and-verify.data.json`
- Reporter: CTRF-JSON + JUnit (via `playwright.config.ts`)
