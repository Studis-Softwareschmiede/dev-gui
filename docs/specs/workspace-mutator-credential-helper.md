---
id: workspace-mutator-credential-helper
title: WorkspaceMutator — ambiente git-Credential-Helper bei mutierenden Kommandos neutralisieren
status: active
area: deployment
spec_format: use-case-2.0
version: 1
---

# Spec: WorkspaceMutator — ambiente git-Credential-Helper neutralisieren (`workspace-mutator-credential-helper`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` — hartes Drift-Gate. **Security-relevant** (Auth-Pfad).

## Zweck
`WorkspaceMutator` injiziert den frisch geminteten GitHub-App-Installations-Token korrekt über `GIT_ASKPASS` — aber git konsultiert **konfigurierte Credential-Helper VOR** `GIT_ASKPASS`. In dev-guis eigenem Container ist global `credential.https://github.com.helper = !/usr/local/bin/gh auth git-credential` gesetzt (vom Entrypoint via `gh auth setup-git`). Ist der gh-CLI-Token stale, liefert der Helfer diesen alten Token, git benutzt ihn und der Push/Pull scheitert mit „Invalid username or token" — der frische `GIT_ASKPASS`-Token wird **nie** konsultiert. Diese Spec verlangt, dass `WorkspaceMutator` bei **allen mutierenden** git-Kommandos den ambienten Credential-Helper per Command-Scope-Flag **neutralisiert**, sodass git ausschließlich den über `GIT_ASKPASS` injizierten Token verwendet.

## Kontext & Abgrenzung
Der Bug betrifft `WorkspaceMutator` **generell** (jeden mutierenden git-Weg), nicht nur die Rotation. Er wurde am 2026-07-14 live gegen `sandbox-flutter` im finalen `git push` der per-App-GPG-Passphrase-Rotation ([[per-app-gpg-passphrase-rotation]] AC11/AC13) reproduziert (`errorClass: push-failed`, obwohl die Rollback-Sicherung korrekt griff). Isolierter Beweis mit demselben gültigen Token: `git push origin HEAD:main` via `GIT_ASKPASS` scheitert **mit** ambientem Helfer, klappt **ohne** (`git -c credential.helper= -c "credential.https://github.com.helper=" push …`). HOME des `docker exec` und des Serverprozesses sind identisch (`/home/node`) — die Interferenz trifft also den echten Server-git-Aufruf.

Die bestehende `GIT_ASKPASS`/`minimalGitEnv`-Mechanik (Token nur via zufällig benannte Env-Var, nie in argv; minimales Kind-Env) bleibt **unverändert** — diese Spec ergänzt ausschließlich die Command-Scope-`-c`-Flags **vor** dem jeweiligen git-Subkommando.

**Nicht Teil dieser Spec:** der operative Zweitfaktor (siehe Edge-Cases „degradierte Container-App-Auth"); GPG-/Rotations-Logik ([[per-app-gpg-passphrase-rotation]]); `GitHubCloner`-`git clone` (frischer Klon; falls dort dieselbe Helfer-Interferenz beobachtet wird → separates Item, hier nur Hinweis).

## Verhalten
1. Vor **jedem** mutierenden git-Subkommando setzt `WorkspaceMutator` zwei Command-Scope-Flags: `-c credential.helper=` (leerer Wert **löscht** die gesamte Helfer-Liste; Command-Scope überstimmt system + global + alle Scopes) **plus** `-c credential."https://github.com".helper=` (host-spezifische Absicherung). Beide Flags stehen **vor** dem Subkommando (`git -c … -c … <subcommand> …`).
2. Dadurch wird git gezwungen, **ausschließlich** den über `GIT_ASKPASS` injizierten Token zu verwenden — ambiente Helfer (inkl. `!gh auth git-credential`) werden ignoriert.
3. Betroffen sind mindestens: in `commitAndPushFile` die Subkommandos `rev-parse`, `symbolic-ref`/Branch-Verifikation, `add`, `commit`, `push`, `reset` (Rollback); in `pullClone` die Subkommandos `pull` (und ein etwaiges `rev-parse`/`fetch`). Kurz: **alle** git-Aufrufe, die im Auth-Pfad gegen `origin` laufen oder Teil eines mutierenden Ablaufs sind, tragen die Flags.
4. Die Flag-Werte sind **leer** (keine Secrets) — sie erscheinen unbedenklich in argv; der Token bleibt weiterhin ausschließlich im `GIT_ASKPASS`-Env-Var-Pfad, nie in argv.

## Acceptance-Kriterien
- **AC1** — **Jedes** mutierende git-Subkommando in `commitAndPushFile` (`rev-parse`, Branch-Verifikation, `add`, `commit`, `push`, `reset`) **und** in `pullClone` (`pull` sowie etwaiges `rev-parse`/`fetch`) wird mit den beiden Command-Scope-Flags `-c credential.helper=` **und** `-c credential.https://github.com.helper=` aufgerufen, jeweils **vor** dem Subkommando. (Testbar: Unit-Test mockt `execFn` und assertiert für jeden git-Aufruf, dass die argv die beiden Flags in genau dieser Position — vor dem Subkommando — enthalten.)
- **AC2** — Die bestehende Token-Injektion bleibt unverändert: der Token wird weiterhin ausschließlich über `GIT_ASKPASS` + zufällig benannte Env-Var (`minimalGitEnv`) übergeben und erscheint **nie** in argv; die neu ergänzten `-c`-Flags tragen **leere** Werte (kein Secret in argv). (Testbar: argv enthält keinen Token; die `-c`-Flag-Werte sind leer; `GIT_ASKPASS`/Env-Var-Mechanik der Bestands-Tests bleibt grün.)
- **AC3** — Gegen einen ambient konfigurierten Helfer (`git config --global credential.https://github.com.helper '!gh auth git-credential'` mit **stale** gh-Token) verwendet ein `commitAndPushFile`/`pullClone`-Lauf **ausschließlich** den frischen `GIT_ASKPASS`-Token und schlägt **nicht** mehr mit „Invalid username or token" fehl. (Verifikation: `reviewer`/`tester` prüfen dies **gegen den aktiven ambienten Helfer** im Container/mit gesetzter git-Config — der reine jsdom/Unit-Lauf deckt die Interferenz nicht auf; der Bug war nur im Container mit aktivem Helfer sichtbar. Lesson coder/R08-nah: Container-only-Reproduktion.)

## Verträge
- **`WorkspaceMutator#commitAndPushFile(name, relFilePath, mintTokenFn, { commitMessage })`** und **`WorkspaceMutator#pullClone(name, mintTokenFn)`**: Signaturen + Rückgaben (`{ summary }`) + Fehlerklassen (`MutatorErrorClass`) **unverändert**. Einzige Änderung: jedem intern abgesetzten `git`-Aufruf werden die zwei Command-Scope-`-c`-Flags **vorangestellt** (vor dem Subkommando).
- **Flag-Kanon (Reihenfolge fixiert):** `git -c credential.helper= -c credential.https://github.com.helper= <subcommand> …`.
- **Unberührt:** `GIT_ASKPASS`-Script (`writeAskpassScript`), `minimalGitEnv`-Allowlist, Token-Minting (`githubAppToken.js`), Traversal-/Symlink-Flucht-Guards, Branch-Verifikation gegen `refs/remotes/origin/HEAD`, Rollback via `git reset --hard <prevHead>`, Secret-Redaktion in stdout/stderr.

## Edge-Cases & Fehlerverhalten
- **Kein ambienter Helfer konfiguriert** ⇒ die leeren `-c`-Flags sind ein harmloser No-op; Verhalten identisch zu vorher (Verhaltensneutralität außerhalb des Bug-Falls).
- **Degradierte Container-App-Auth (operativer Zweitfaktor, NICHT Code-Fix dieser Spec):** Beobachtung 2026-07-14 — dev-guis frisch geminteter Push-Token wurde im laufenden Container zeitweise **auch ohne** Helfer abgelehnt (gh-CLI meldete „Bad credentials"), was auf eine degradierte Container-GitHub-App-Auth / fehlgeschlagenen periodischen Token-Refresh hindeutet. Das ist **operativ** (ein frischer Container/Deploy mintet neu) und **nicht** Teil dieses Fixes. → ggf. separates Beobachtungs-Item (Container-Token-Refresh-Health), hier nur als Hinweis vermerkt.

## NFRs
- **Sicherheit (Floor, hart):** kein Token/Secret in argv, Log, Audit, Response, WS, Bundle; die neuen `-c`-Flags tragen leere Werte; Token ausschließlich via `GIT_ASKPASS`-Env-Var.
- **Robustheit:** deterministisch, scope-unabhängig (Command-Scope überstimmt system/global/alle Scopes); Verhaltensneutralität, wenn kein ambienter Helfer greift.

## Nicht-Ziele
- GPG-/Rotations-Logik, Bitwarden-Zwei-Seiten-Atomarität → [[per-app-gpg-passphrase-rotation]].
- `GitHubCloner`-`git clone` (separates Item, falls dort dieselbe Interferenz beobachtet wird).
- Behebung der degradierten Container-App-Auth / des periodischen Token-Refresh (operativ, ggf. eigenes Item).

## Abhängigkeiten
- [[per-app-gpg-passphrase-rotation]] (der Push-Pfad, in dem der Bug live auftrat — AC11/AC13).
- [[github-app-token-unification]] / [[github-repo-clone]] (`GIT_ASKPASS`/Token-Minting-Mechanik, unverändert).
