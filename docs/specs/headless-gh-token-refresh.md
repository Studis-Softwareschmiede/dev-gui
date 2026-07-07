---
id: headless-gh-token-refresh
title: Headless-GitHub-Token-Refresh — periodischer Refresh im Container-Entrypoint statt Einmal-Mint
status: active
area: fabrik-arbeiten
version: 1
spec_format: use-case-2.0
---

# Spec: Headless-GitHub-Token-Refresh  (`headless-gh-token-refresh`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Mehrstündige **headless-Drains** (manueller „Board abarbeiten"-Knopf **und** Nachtwächter) sollen einen Ablauf des GitHub-App-Tokens **ohne manuellen Eingriff** überleben. Der Container-Entrypoint mintet den App-Token heute **nur einmal beim Start** (~60 min gültig); die von den `claude -p`-Kindprozessen gelesene `gh`-Auth wird danach nie erneuert. Diese Spec ergänzt einen **periodischen Refresh im Entrypoint**, sodass laufende Sessions dauerhaft eine gültige `gh`/git-Auth vorfinden — **ohne** dass die Sessions je das Langzeit-Master-Secret (`GPG_PASSPHRASE`) in Reichweite bekommen.

## Kontext / Problem (Vorfall 2026-07-07)
- Der Entrypoint (`docker-entrypoint.sh`) mintet den App-Token über `ensure-gh-auth.sh` **einmal** vor `exec node server.js`.
- Ein headless-Drain lief 05:52–08:10 UTC (10 flowRuns, 0 completed): nach Token-Ablauf konnten die Sessions **nicht re-minten**, weil `buildChildEnv()` (`src/HeadlessRunnerCore.js`) den Kindprozessen bewusst nur eine Env-Allowlist übergibt (`PATH/HOME/LANG/… + CLAUDE_CODE_OAUTH_TOKEN`) — `GPG_PASSPHRASE`/`GH_TOKEN` werden **gestrippt**, und `gpg.pass`-Dateien existieren im Container nicht.
- Folge: Storys wurden implementiert, aber **nicht gelandet**; der Taktgeber eskalierte nach 3 Läufen auf `Blocked` (S-306/S-307/S-312, F-067).

## Gewählte Lösung (Owner-Entscheidung, Security-getrieben)
Der Entrypoint startet **nach** dem erfolgreichen gh-Auth-Bootstrap und **vor** `exec node server.js` eine **Hintergrund-Refresh-Schleife**, die in festem Intervall (Default ~45 min, konfigurierbar; strikt **kleiner** als die ~60-min-Token-Gültigkeit) erneut `ensure-gh-auth.sh` aufruft. `ensure-gh-auth.sh` nutzt `GPG_PASSPHRASE` **aus der Server-Env des Entrypoints** (nicht aus einer Child-Env), mintet einen frischen App-Token und aktualisiert die **Ist-Ablagen**, die die Sessions lesen:
- die persistente `gh`-Konfiguration unter `$HOME` (`$HOME/.config/gh/hosts.yml`, via `gh auth login --with-token`) und
- die git-Credential-Ablage (via `gh auth setup-git`).

Weil `gh` seine Konfiguration **pro Aufruf neu liest**, profitieren bereits laufende Sessions automatisch vom Refresh — **ohne Neustart**. Die Schleife übernimmt die **bestehenden** Ablagen aus `ensure-gh-auth.sh` und erfindet **keine** neuen Pfade.

## Verhalten
1. **Boot:** unverändert — einmaliger gh-Auth-Bootstrap über `ensure-gh-auth.sh`; schlägt er fehl, startet der Server trotzdem (best-effort).
2. **Nach Bootstrap:** der Entrypoint startet die Refresh-Schleife als **Hintergrundprozess** und fährt dann mit `exec node server.js` als PID 1 fort (die Schleife läuft nebenläufig weiter, blockiert den Server-Start nicht).
3. **Je Intervall:** die Schleife schläft das Intervall ab, ruft dann `ensure-gh-auth.sh` erneut auf (mintet frischen Token, aktualisiert `$HOME/.config/gh` + git-Credential-Ablage).
4. **Erfolg:** ein secret-freier Info-Log-Eintrag; die laufenden Sessions sehen beim nächsten `gh`/git-Aufruf die frische Auth.
5. **Fehler (z.B. Netz weg, GPG/Mint scheitert):** ein **klarer, secret-freier** Warnhinweis wird geloggt; die Schleife **crasht nicht** und beendet weder sich selbst noch `node server.js`, sondern versucht es beim **nächsten** Intervall erneut.

## Acceptance-Kriterien

- **AC1** — Der Entrypoint startet **nach** erfolgreichem gh-Auth-Bootstrap und **vor** `exec node server.js` eine Hintergrund-Refresh-Schleife. Das Refresh-Intervall ist konfigurierbar (Env-Var, secret-frei), Default ~45 min und in jedem Fall **strikt kleiner** als die Token-Gültigkeit (~60 min).
- **AC2** — Jeder Schleifendurchlauf ruft dasselbe `ensure-gh-auth.sh` (Plugin-Skript, Auflösung über den bestehenden Plugin-Cache-Pfad-Mechanismus des Entrypoints) auf und aktualisiert damit **ausschließlich die bestehenden Ist-Ablagen** — `$HOME/.config/gh` (via `gh auth login --with-token`) und die git-Credential-Ablage (via `gh auth setup-git`); es werden **keine** neuen/zusätzlichen session-lesbaren Ablagen angelegt.
- **AC3** — Ein headless-Drain, der **länger als die Token-Gültigkeit** läuft, landet Storys weiterhin **ohne manuellen Eingriff** (Regression zum Vorfall 2026-07-07): nach einem Refresh-Intervall funktionieren `gh`- und git-push-Operationen der Sessions wieder, obwohl der Boot-Token bereits abgelaufen wäre.
- **AC4** *(Security)* — `GPG_PASSPHRASE` (Langzeit-Master-Secret) erscheint **weder** in der Child-Env der Sessions **noch** an einem session-lesbaren Pfad: die Env-Allowlist `buildChildEnv()`/`BASE_ALLOWED_ENV_KEYS` in `src/HeadlessRunnerCore.js` bleibt **unverändert** (kein `GPG_PASSPHRASE`, kein `GH_TOKEN`), und die Schleife schreibt **keine** `gpg.pass`-/Passphrase-Datei an einen von den Sessions lesbaren Pfad. Der Refresh nutzt `GPG_PASSPHRASE` nur im Entrypoint-Prozess selbst.
- **AC5** *(Security)* — An die Sessions gelangen nur die **kurzlebigen** (≤ ~60 min) App-Tokens über die persistente `gh`/git-Ablage — nie das langlebige Master-Secret. Blast-Radius eines kompromittierten Session-Kontexts bleibt auf ein kurzlebiges Token begrenzt.
- **AC6** *(Robustheit)* — Schlägt ein Refresh fehl (z.B. Netz weg, GPG-/Mint-Fehler, Skript nicht gefunden), loggt die Schleife einen **klaren, secret-freien** Hinweis und läuft weiter: **kein Container-Crash**, `node server.js` läuft ungestört weiter, und das **nächste** Intervall versucht es erneut. Kein geloggter Wert enthält Passphrase oder Token.
- **AC7** *(Fangnetz unverändert)* — Die bestehende 401-/Auth-Fehler-Erkennung in `src/HeadlessRunnerCore.js` (`isAuthError`, `AUTH_ERROR_PATTERN`) bleibt **unverändert** als Fangnetz für den Fall, dass ein Refresh doch einmal zu spät kommt.

## Verträge
- **Refresh-Skript:** `ensure-gh-auth.sh` (agent-flow-Plugin) — Eingang: `GPG_PASSPHRASE` (Entrypoint-Env) + `.env.gpg` im Plugin-Tree. Wirkung: mintet frischen App-Token, `gh auth login --with-token` → `$HOME/.config/gh/hosts.yml`, `gh auth setup-git` → git-Credential-Helper. Idempotent, secret-frei in der Ausgabe.
- **Skript-Auflösung:** über den **bestehenden** Plugin-Cache-Pfad-Mechanismus des Entrypoints (`find $HOME/.claude/plugins/cache/agent-flow …`) — kein hartkodierter, versions-fixierter Pfad.
- **Intervall-Konfiguration:** eine Env-Var (secret-frei, z.B. `GH_TOKEN_REFRESH_INTERVAL_SECONDS` o.ä.), Default entspricht ~45 min; unbedingt < Token-Gültigkeit.
- **Child-Env (unverändert):** `buildChildEnv()` liefert `BASE_ALLOWED_ENV_KEYS` (`PATH/HOME/LANG/LC_ALL/LC_CTYPE/TZ/USER/LOGNAME/SHELL`) + optional `CLAUDE_CODE_OAUTH_TOKEN`; `BLOCKED_ENV_KEYS` bleibt bestehen. **Keine** Aufnahme von `GPG_PASSPHRASE`/`GH_TOKEN`.

## Edge-Cases & Fehlerverhalten
- **Netz weg / GitHub nicht erreichbar beim Refresh:** Warnung loggen, weiterlaufen, nächstes Intervall erneut (AC6).
- **Skript nicht gefunden (Plugin fehlt/Pfad geändert):** Warnung loggen, weiterlaufen — degradiert auf den Boot-Token bzw. das 401-Fangnetz.
- **Boot-Bootstrap schlug schon fehl:** die Schleife startet trotzdem und kann bei einem späteren Intervall die Auth nachziehen (best-effort), ohne den Server-Start zu blockieren.
- **Refresh genau während einer laufenden git-Operation:** unkritisch, da `gh`/git die Config pro Aufruf neu lesen und der Refresh atomar über die `gh`-eigenen Schreibpfade läuft.

## NFRs
- **Security (primär):** Das Langzeit-Master-Secret (`GPG_PASSPHRASE`) verlässt nie den Entrypoint-Prozess; Sessions (die mit `--dangerously-skip-permissions` laufen) erhalten ausschließlich kurzlebige Tokens. Kein Secret in Log/Prozessliste/Datei an session-lesbaren Pfaden.
- **Robustheit:** Kein Refresh-Fehler darf den Container beenden (best-effort, degradierend).

## Nicht-Ziele — bewusst verworfene Alternativen (Security-Begründung)
Zwei naheliegende Alternativen wurden **bewusst verworfen**, weil sie das langlebige Master-Secret in die Reichweite der Sessions brächten:
1. **`GPG_PASSPHRASE` in die Child-Env-Allowlist (`buildChildEnv`) aufnehmen** — verworfen: gäbe jeder `claude -p`-Session dauerhaft das Master-Secret.
2. **`gpg.pass` als Datei an session-lesbare Pfade mounten/schreiben** — verworfen: gleiches Problem über den Dateipfad.

**Begründung:** Die Sessions laufen mit `--dangerously-skip-permissions`; das Langzeit-Master-Secret darf nicht in ihre Reichweite. Kurzlebige (≤ ~60 min) Tokens sind der **kleinere Blast-Radius** — genau die richtige Trade-off-Wahl. Deshalb bleibt das Minten (das `GPG_PASSPHRASE` braucht) im **Entrypoint-Prozess** und die Sessions sehen nur das Ergebnis (die frische `gh`/git-Auth).

Ebenfalls **kein** Ziel: Änderung des Session-Ausführungsmodells, ein UI/Status-Badge für den Refresh, oder ein Anthropic-API-Pfad.

## Abhängigkeiten
- `ensure-gh-auth.sh` (agent-flow-Plugin) — die Ist-Mint-/Ablage-Mechanik; diese Spec ruft es nur periodisch erneut auf.
- `docker-entrypoint.sh` — Träger der Refresh-Schleife.
- `src/HeadlessRunnerCore.js` — `buildChildEnv()` (bleibt unverändert) + `isAuthError` (Fangnetz).
- Verwandt: [[drain-restart-robustness]] (Drain-Robustheit gegen Server-Neustart — andere Robustheits-Dimension, gleiche Familie), [[claude-code-oauth-token]] (der **andere** langlebige Token, Claude-OAuth, hier nicht betroffen).
