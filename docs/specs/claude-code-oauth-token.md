---
id: claude-code-oauth-token
title: Claude-Code-OAuth-Token durchreichen (Container-Auth für Agent-Sessions)
status: draft
area: einstellungen
version: 1
---

# Spec: Claude-Code-OAuth-Token durchreichen  (`claude-code-oauth-token`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck

Der Container versorgt die gespawnten `claude`-PTY-Sessions dauerhaft mit einer gültigen Claude-Anmeldung. Heute läuft die Anmeldung über die interaktive OAuth-Datei (`~/.claude/state.json`), die abläuft — sobald sie ungültig ist, scheitert **jeder** headless-`claude -p`-Lauf (reconcile, `/flow`, Nachtwächter) mit `401 Invalid authentication credentials` und blockiert die gesamte Fabrik. Es gibt kein automatisches Gegenstück zum GitHub-Token-Refresh.

Claude Code stellt dafür ein **langlebiges Token** bereit (`claude setup-token`, Claude-Abo nötig), das über die Env-Variable **`CLAUDE_CODE_OAUTH_TOKEN`** konsumiert wird. Diese Spec verdrahtet dieses Token vom host-`.env` bis in die Prozess-Umgebung des gespawnten Agenten — nach demselben gitignored-Secret-Muster wie `GPG_PASSPHRASE`.

## Verhalten

1. **Herkunft (Single Source, gitignored).** Der Token-Wert lebt ausschliesslich im host-`.env` (nicht im Repo, nicht im Commit). `docker-compose.yml` reicht ihn per `${CLAUDE_CODE_OAUTH_TOKEN:-}` in die Container-`environment:` — leer, wenn der Host ihn nicht setzt (kein Boot-Bruch).
2. **Durchreichung an die Agent-Session.** `src/PtyManager.js` baut die Child-Env aus einer **expliziten Allowlist** (`ALLOWED_ENV_KEYS`, security/R01 — siehe [[terminal-bridge]] AC3). `CLAUDE_CODE_OAUTH_TOKEN` steht **auf** dieser Allowlist: Ist es im Server-Prozess gesetzt, erbt es die gespawnte `claude`-PTY; ist es nicht gesetzt, wird nichts hinzugefügt (kein leerer Key).
3. **Trust-Boundary-Unterscheidung.** `CLAUDE_CODE_OAUTH_TOKEN` ist die **Auth des Agenten selbst** und wird bewusst durchgereicht — im Gegensatz zu `ANTHROPIC_API_KEY`, das ein **server-only**-Secret bleibt und **nicht** in die Child-Env gelangen darf. Beide Bedingungen gelten gleichzeitig.
4. **Boot-Diagnose (best-effort, nicht blockierend).** `docker-entrypoint.sh` prüft beim Boot, ob `CLAUDE_CODE_OAUTH_TOKEN` gesetzt ist. Fehlt es, gibt der Entrypoint eine Warnung ins Boot-Log aus (analog zum gh-Auth-Bootstrap) und startet den Server trotzdem — **keine** Boot-Blockade. Der Token-Wert selbst wird **nie** geloggt.
5. **Dokumentation.** `.env.example` dokumentiert die neue Variable inklusive Hinweis, wie sie erzeugt wird (`claude setup-token`, Claude-Abo nötig).

## Acceptance-Kriterien

- **AC1** — `docker-compose.yml` verdrahtet `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}` in der `environment:`-Sektion des dev-gui-Service, nach dem bestehenden gitignored-Secret-Muster (wie `GPG_PASSPHRASE`/`GH_TOKEN`). Testbar: die kompilierte Compose-Config (`docker compose config`) zeigt den Key; bei ungesetztem Host-Env ist der Wert leer, ohne Fehler.
- **AC2** — `src/PtyManager.js` enthält `CLAUDE_CODE_OAUTH_TOKEN` in `ALLOWED_ENV_KEYS`. Ist die Variable im Server-Prozess gesetzt, erscheint sie in der Child-Env der gespawnten PTY. Testbar (Unit-Test mit Stub-`process.env`): bei gesetztem `CLAUDE_CODE_OAUTH_TOKEN` enthält die Child-Env den Key mit dem Wert; ist sie **nicht** gesetzt, fehlt der Key in der Child-Env (kein leerer Eintrag).
- **AC3** — **Trust-Boundary bleibt intakt (security).** Im selben Child-Env-Aufbau wird `ANTHROPIC_API_KEY` **nicht** durchgereicht, auch wenn im Server-Prozess gesetzt. Testbar (Unit-Test): bei gleichzeitig gesetztem `CLAUDE_CODE_OAUTH_TOKEN` **und** `ANTHROPIC_API_KEY` enthält die Child-Env den OAuth-Token, aber **nicht** `ANTHROPIC_API_KEY`.
- **AC4** — `docker-entrypoint.sh` gibt bei **fehlendem** `CLAUDE_CODE_OAUTH_TOKEN` beim Boot eine Warnung aus (Text im Sinne: „Claude-Auth-Token nicht gesetzt — /agent-flow:*-Läufe schlagen mit 401 fehl"), blockiert den Boot **nicht** und loggt den Token-Wert **nie**. Testbar: Entrypoint mit ungesetztem Token → Warnzeile auf stderr, Exit-Code des Boot-Schritts bleibt 0; mit gesetztem Token → keine Warnung.
- **AC5** — `.env.example` dokumentiert `CLAUDE_CODE_OAUTH_TOKEN` mit erklärendem Kommentar (Erzeugung via `claude setup-token`, Claude-Abo nötig, gitignored). Testbar: `.env.example` enthält eine `CLAUDE_CODE_OAUTH_TOKEN`-Zeile mit Kommentarblock; der Wert ist ein Platzhalter, kein echtes Token.

## Verträge

**Env-Variable:** `CLAUDE_CODE_OAUTH_TOKEN` (String, langlebiges Claude-Code-OAuth-Token; erzeugt via `claude setup-token`).

- **Compose → Container:** `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}` (Quelle host-`.env`, gitignored).
- **Server-Prozess → PTY-Child-Env:** Allowlist-Eintrag in `ALLOWED_ENV_KEYS`; Passthrough nur, wenn `process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined`.
- **Blockiert (nicht auf Allowlist):** `ANTHROPIC_API_KEY` (unverändert, server-only).

## Edge-Cases & Fehlerverhalten

- **Token nicht gesetzt:** Compose-Wert leer, PTY-Child-Env ohne Key, Entrypoint-Warnung, Boot läuft weiter. Der reale 401 tritt erst beim `claude`-Lauf auf — erwartetes Verhalten ohne hinterlegtes Token.
- **Token gesetzt aber ungültig/abgelaufen:** ausserhalb dieser Spec (kein Format-/Gültigkeits-Check im Container); der `claude`-Lauf meldet dann 401. Der reale 401→OK-Beweis erfolgt beim Deploy mit echtem Token (manuell verifiziert).
- **Kein Token-Wert im Log:** weder Compose, PtyManager noch Entrypoint dürfen den Token-Wert ausgeben.

## NFRs

- **Security/Trust-Boundary:** Der OAuth-Token ist Agent-Auth (durchgereicht), `ANTHROPIC_API_KEY` bleibt server-only (blockiert). Kein Token-Wert in Logs, Repo oder Commit. Host-`.env` ist gitignored.

## Nicht-Ziele

- **Kein** Headless-Reconcile-Runner: der spätere Runner (Story B) braucht denselben Token in seiner Spawn-Env — hier nur als Abhängigkeit vermerkt, **nicht** gebaut.
- **Kein** Format-/Gültigkeits-Check oder automatischer Token-Refresh im Container.
- **Kein** Ablegen eines echten Token-Werts im Repo.

## Abhängigkeiten

- [[terminal-bridge]] — AC3 (`ALLOWED_ENV_KEYS`-Allowlist des PTY-Child-Env). Diese Spec erweitert die Allowlist um `CLAUDE_CODE_OAUTH_TOKEN`; die terminal-bridge-Aufzählung ist entsprechend nachzuziehen.
- [[hardening]] — Login-/Auth-Kette + `/home/node`-Mounts (Kontext, keine Änderung).
- **Nachgelagert (nicht Teil dieser Spec):** Headless-Reconcile-Runner (Story B) benötigt `CLAUDE_CODE_OAUTH_TOKEN` in seiner Spawn-Env.
