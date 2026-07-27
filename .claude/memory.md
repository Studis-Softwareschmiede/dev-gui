> Orientierung, nie Wahrheit: bei Widerspruch gelten Board + docs/specs/.
> Kuratiert von /flow am Ende jeder Session. Max. 60 Zeilen.

## Aktueller Stand
F-098 (Leerlauf-Berichts-Hygiene) ist mit S-426 komplett auf
feature/F-098 — der Feature-Drain kann den gebündelten Merge in main
fahren. F-096 (target:local-Regressionslauf) liegt vollständig auf
feature/F-096 und wartet ebenfalls auf den Feature-Merge (vorher
ADR-Eintrag zu A1 nachziehen, s. Offene Fäden). F-072 (Deploy-Bitwarden)
verbleibt S-414. F-099 (S-427/S-428) ist angelegt, Stories noch nicht
ready. Der echte AC11-Live-Lauf (flashrescue-Verbund aus der Oberfläche,
F-096) steht als Owner-Verifikation aus.

## Letzte Arbeiten
- S-426 / Leerlauf-Berichte aggregieren (AC8–AC10 drain-completion-
  report): Done-Nachtrag — Story-Commit 2d0ec75 (DrainReportStore
  Merge-on-persist, idempotente Lade-Kompaktion, Serien-Zeile in
  NightRunsSection, GET /api/drain-reports additiv firstAt/lastAt/count)
  lag schon auf feature/F-098; Feature-Drain hatte die Story fälschlich
  auf To Do zurückgesetzt. Voller Testlauf grün (8660 Tests). Keine
  Metrik-Zeile (keine Dispatches dieser Session).
- S-418 / REAL_SEND-Gate + Test-Config-Leitkanal (AC9/AC10 regression-
  local-execution): Hard-Strip in defaultRunPlaywright; voller Env-
  Durchgriff als Leitkanal. AC11 nicht live verifiziert. EP 3/4.
- S-417 / App-Secrets via Bitwarden/GPG (AC7/AC8): resolveLocal-
  RegressionSecrets — .env.gpg via gpg -d, Secrets nur in die
  Playwright-Kind-Env; fehlendes Secret → kontrollierter Skip. EP 4/5.25.
- S-419 / Verbund-Scope ohne id (AC13): validateScope akzeptiert
  { typ: "verbund" }. EP 3/3.
- S-416 / Port + Ziel-Adressierung (AC4–AC6): host.docker.internal vs
  127.0.0.1-Auflösung. EP 4/7.
- S-386 / Done-Nachtrag F-072: Fix war als PR #431 längst auf main +
  deployt; nur Board-Status nachgezogen, keine Metrik.

## Offene Fäden
- Vor dem F-096-Merge: ADR-Eintrag zu A1 (Playwright-Browser fest im
  Image + zentrales Versions-Pinning) in docs/architecture.md.
- AC11-Live-Verifikation braucht -v <host>:/app/config-Mount am
  flashrescue-Container (Deployment-Voraussetzung, kein dev-gui-Code).
- ⚠ F-095: red-team-End-JSON ohne findings/checks-Array — Store bleibt
  leer (ehrliche Degradation), bis der Skill strukturierte Arrays
  liefert. Owner-Entscheid offen.
- VALIDATE_ERROR_MESSAGES kennt config-failed nicht — S-414 (F-072).
- Feature-Drain-Reset vs. gelandete Arbeit: Drain setzt liegengebliebene
  Stories auf To Do zurück, ohne zu prüfen, ob der Story-Commit schon im
  Feature-Branch liegt — vor coder-Dispatch immer flow/L10-Check.
- Landen aus Worktree: Modus B (--target-branch) läuft (flow/L09);
  Modus A von Hand (flow/L07, Retro-Issue #371 offen).
- Testläufe im Worktree: npm run test:worktree (S-400) bzw. temporäre
  jest.worktree.config.mjs.
