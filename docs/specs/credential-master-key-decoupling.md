---
id: credential-master-key-decoupling
title: Store-Master-Key entkoppeln + umbenennen (DEVGUI_CRED_MASTER_KEY)
status: draft
version: 1
---

# Spec: Store-Master-Key entkoppeln + umbenennen (`credential-master-key-decoupling`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch (Drift-Gate).

## Zweck
Der Master-Key des Credential-Stores (ADR-007) wird ein **eigenes, dev-gui-spezifisches Geheimnis**, das **getrennt** von der GPG-Passphrase (`GPG_PASSPHRASE`, öffnet nur `.env.gpg`/GitHub-Auth) beschafft und benannt wird. Der bisherige Entrypoint-Fallback `GPG_PASSPHRASE → CRED_MASTER_KEY` (der dev-gui faktisch immer „unlocked" starten ließ und damit den Unlock-Dialog aus #185 nie erscheinen ließ) wird **entfernt** und durch eine eigene Schlüssel-Quelle ersetzt. Der neue Env-Name ist **`DEVGUI_CRED_MASTER_KEY`** (Präfix-Konvention wie `RAPT_`/`ASSISTENT_`); das zugehörige Bitwarden-Item ist **`dev-gui-cred-master-key`** (getrennt von `studis-softwareschmiede-gpg-passphrase`). Eine **sanfte Migration** akzeptiert übergangsweise noch das alte `CRED_MASTER_KEY` als deprecated-Fallback (mit Warn-Log, **ohne** Wert im Log), damit bestehende Installationen nicht ausgesperrt werden.

Diese Spec ist Voraussetzung für [[credential-key-status-transparency]] (Key-Quelle „auto"/„manual") und für die spätere Master-Key-Rotation ([[credential-key-rotation]] — nur `DEVGUI_CRED_MASTER_KEY` wird rotiert, nie `GPG_PASSPHRASE`).

## Verhalten
1. **Zwei Modi, eine Quelle.** Der Store-Master-Key stammt aus Bitwarden, über zwei komplementäre Bezugswege mit klarer Priorität:
   - **(a) AUTONOM (Default):** Bootstrap/Entrypoint stellt den Key als Env (`DEVGUI_CRED_MASTER_KEY`) bzw. über `.env` bereit → Container startet **unlocked** → Nacht-Jobs (ReconciliationJob, ADR-013) laufen.
   - **(b) INTERAKTIV (Recovery/Erst-Setup):** ist **kein** autonomer Key vorhanden → Store startet **locked** → Bitwarden-Unlock-Dialog ([[credential-unlock-dialog]]) → unlock + `.env`-Persistenz ([[credential-runtime-unlock]]).
2. **Prioritätskette (bindend):** `explizit gesetzter Key / .env (DEVGUI_CRED_MASTER_KEY)` **>** `DEVGUI_CRED_MASTER_KEY_FILE` **>** `deprecated CRED_MASTER_KEY` (Übergangs-Fallback, Warn-Log) **>** `deprecated CRED_MASTER_KEY_FILE` (Warn-Log) **>** Dialog-Recovery (locked). **Kein** Wert aus `GPG_PASSPHRASE` oder `gpg.pass` fließt mehr in den Store-Key.
3. **Entrypoint-Entkopplung:** Der bisherige Block, der bei fehlendem `CRED_MASTER_KEY(_FILE)` auf `GPG_PASSPHRASE` bzw. die gemountete `gpg.pass` zurückfällt, wird **entfernt/ersetzt**. `GPG_PASSPHRASE` bleibt ausschließlich für `.env.gpg`/GitHub-Auth-Bootstrap. Künftig bringt der Bootstrap **zwei** getrennte Bitwarden-Items mit (GPG-Passphrase **und** `dev-gui-cred-master-key`); der Entrypoint exportiert daraus `DEVGUI_CRED_MASTER_KEY` (bzw. setzt nichts → locked, wenn das Item fehlt).
4. **Code liest neuen Namen + deprecated-Fallback:** Der `CredentialStore` und alle Konsumenten lesen primär `DEVGUI_CRED_MASTER_KEY` / `DEVGUI_CRED_MASTER_KEY_FILE`. Ist **nur** das alte `CRED_MASTER_KEY` / `CRED_MASTER_KEY_FILE` gesetzt, wird dessen Wert **übergangsweise** akzeptiert und genau **eine** Deprecation-Warnung geloggt (Text nennt den neuen Namen, **nie** den Wert).
5. **`.env`-Persistenz schreibt den neuen Namen:** Runtime-Unlock ([[credential-runtime-unlock]]) persistiert künftig `DEVGUI_CRED_MASTER_KEY=<wert>` in `.env` (nicht mehr `CRED_MASTER_KEY=`). Beim Schreiben werden **beide** Schlüsselnamen (alt + neu) aus den bestehenden Zeilen entfernt, dann der neue gesetzt → kein Duplikat, keine stale alte Zeile, die beim nächsten Boot über die Prioritätskette einen anderen Wert liefern könnte.
6. **Fail-Fast bleibt (ADR-007).** Existieren verschlüsselte Einträge (`kdf` vorhanden UND `entries` nicht leer) UND es ist **über keine** Quelle der Prioritätskette ein Key beschaffbar → Fail-Fast beim Boot (unverändert). Locked-ohne-Abbruch gilt nur bei leerem/meta-only Store ([[credential-runtime-unlock]] AC1/AC2).
7. **docker-compose konsistent:** Der Compose-`environment`-Block bietet `DEVGUI_CRED_MASTER_KEY` (Option A) + `DEVGUI_CRED_MASTER_KEY_FILE` (Option B) an; der alte `CRED_MASTER_KEY`-Block ist als **deprecated** markiert/auskommentiert mit Hinweis auf den neuen Namen. Der GPG-Block bleibt unverändert, ohne Hinweis auf einen Store-Key-Fallback.
8. **Sicherheits-Floor (hart):** Weder der alte noch der neue Key-Wert erscheint in Log/Audit/Response/WS/Argv/Frontend-Bundle/Image — auch nicht in der Deprecation-Warnung.

## Acceptance-Kriterien
- **AC1** — Der `CredentialStore` (und Konsumenten) beziehen den Boot-Master-Key aus **`DEVGUI_CRED_MASTER_KEY`** (bzw. `DEVGUI_CRED_MASTER_KEY_FILE`). Ist nur diese Quelle gesetzt, startet der Store entsprechend unlocked.
- **AC2** — Ist **ausschließlich** das alte `CRED_MASTER_KEY` (bzw. `CRED_MASTER_KEY_FILE`) gesetzt, wird dessen Wert übergangsweise akzeptiert (Store unlocked) **und** genau eine Deprecation-Warnung geloggt, die den neuen Namen nennt und den Wert **nicht** enthält.
- **AC3** — Ist **sowohl** `DEVGUI_CRED_MASTER_KEY` **als auch** `CRED_MASTER_KEY` gesetzt, gewinnt **`DEVGUI_CRED_MASTER_KEY`** (Prioritätskette); das alte wird ignoriert (keine stille Vermischung).
- **AC4** — Der Entrypoint setzt/leitet `DEVGUI_CRED_MASTER_KEY` **nicht** mehr aus `GPG_PASSPHRASE` oder `gpg.pass` ab; ist kein dedizierter Store-Key vorhanden, bleibt der Store **locked** (kein impliziter Unlock über die GPG-Passphrase). (Testbar: bei gesetztem `GPG_PASSPHRASE`, aber ohne `DEVGUI_CRED_MASTER_KEY`/altes `CRED_MASTER_KEY` und ohne verschlüsselte Einträge ⇒ `state: "locked"`.)
- **AC5** — Runtime-Unlock persistiert `DEVGUI_CRED_MASTER_KEY=<wert>` in `.env`; eine zuvor vorhandene `CRED_MASTER_KEY=`-Zeile UND eine vorhandene `DEVGUI_CRED_MASTER_KEY=`-Zeile werden ersetzt/entfernt (kein Duplikat, keine konkurrierende Altzeile). Übrige `.env`-Zeilen bleiben unverändert; Datei atomar geschrieben, mode `0600`.
- **AC6** — Der bestehende Fail-Fast bleibt: verschlüsselte Einträge UND über **keine** Quelle der Prioritätskette ein Key beschaffbar ⇒ Boot bricht ab (Exit ≠ 0). (Regression-Schutz ADR-007/[[credential-runtime-unlock]] AC2.)
- **AC7** — `DEVGUI_CRED_MASTER_KEY` und `CRED_MASTER_KEY` erscheinen **nicht** im Image (Grep Dockerfile/entrypoint), **nicht** im Log (auch nicht in der Deprecation-Warnung), **nicht** im Frontend-Bundle, **nicht** in Audit/Response/WS/Argv.
- **AC8** — `docker-compose.yml` führt `DEVGUI_CRED_MASTER_KEY` (+ `DEVGUI_CRED_MASTER_KEY_FILE`) als Konfig-Pfad; der alte `CRED_MASTER_KEY`-Eintrag ist als deprecated markiert mit Verweis auf den neuen Namen; der GPG-Block enthält **keinen** Store-Key-Fallback-Hinweis mehr.
- **AC9** — Bestehende Installationen, die `unlock` bereits in `.env` als `CRED_MASTER_KEY=` persistiert haben, brechen **nicht**: Der Boot liest den alten Namen über den deprecated-Fallback (AC2) und der nächste erfolgreiche Unlock migriert die `.env`-Zeile auf den neuen Namen (AC5).

## Verträge
- **Env-Vars (neu / kanonisch):**
  - `DEVGUI_CRED_MASTER_KEY` — Roh-Master-Key (Boot). Höchste Priorität.
  - `DEVGUI_CRED_MASTER_KEY_FILE` — Pfad zu einer Datei, deren Inhalt der Key ist (lazy gelesen). Zweite Priorität.
- **Env-Vars (deprecated, Übergangs-Fallback — Warn-Log, ohne Wert):**
  - `CRED_MASTER_KEY`, `CRED_MASTER_KEY_FILE` — nur wirksam, wenn keine `DEVGUI_*`-Variante gesetzt ist.
- **Bitwarden-Item:** `dev-gui-cred-master-key` (Default-Bezeichner für den Store-Master-Key; getrennt von `studis-softwareschmiede-gpg-passphrase`). Konfigurierbar analog [[bitwarden-master-key-unlock]] (`BW_ITEM_NAME`).
- **`.env`-Persistenz-Schlüsselname:** `DEVGUI_CRED_MASTER_KEY` (überschreibbarer Pfad weiterhin via `CRED_ENV_PATH`).
- **`CredentialStore`-Konstruktor/Loader:** Auflösung der Quelle folgt der Prioritätskette aus Verhalten §2; bestehende Signaturen (`getLockState`, `unlock`, `isUnlocked`) bleiben unverändert.

## Edge-Cases & Fehlerverhalten
- Beide Namen gesetzt, unterschiedliche Werte ⇒ `DEVGUI_CRED_MASTER_KEY` gewinnt, **keine** Warnung „Konflikt" mit Werten; höchstens generischer Hinweis ohne Werte.
- `DEVGUI_CRED_MASTER_KEY_FILE` zeigt auf nicht lesbare Datei ⇒ harter Fehler beim Nachladen (kein stilles Fallback auf den alten Namen), Wert nie im Fehler.
- `.env` enthält sowohl alte als auch neue Zeile (Mid-Migration) ⇒ beim nächsten Unlock werden **beide** entfernt und nur die neue geschrieben (AC5).
- Deprecation-Warnung wird **einmalig** pro Prozessstart geloggt (kein Log-Spam pro Request).

## NFRs
- **Sicherheit (Floor, hart):** kein Key-Wert (alt/neu) in Log/Audit/Response/WS/Argv/Bundle/Image; `.env` `0600`, atomar.
- **Rückwärtskompatibilität:** bestehender unlock/`.env`-Zustand bricht nicht (AC9); deprecated-Fallback bleibt, bis die Migration projektweit erledigt ist.
- **Boundary-Disziplin:** `CredentialStore` bleibt einziger Lese-/Schreibpfad zu `secrets.enc.json`; der `.env`-Schreibpfad bleibt eng gekapselt (ein Ort).

## Nicht-Ziele
- Beschaffung des Keys aus Bitwarden (Login/Item-Lesen/Erstellen) → [[bitwarden-master-key-unlock]] (Item-Bezeichner wird hier nur umbenannt).
- Status-Quelle „auto"/„manual" in `credential-status` + SettingsView-Anzeige → [[credential-key-status-transparency]].
- Master-Key-Rotation → [[credential-key-rotation]] (separate, spätere Anforderung).
- Entfernen des deprecated `CRED_MASTER_KEY`-Fallbacks (späteres Cleanup-Item, wenn alle Installationen migriert sind).

## Abhängigkeiten
- [[credential-runtime-unlock]] / ADR-007 (`CredentialStore`, `.env`-Persistenz, Fail-Fast).
- [[bitwarden-master-key-unlock]] (Item-Bezeichner-Konfiguration).
- ADR-014 (Vollfassung, `docs/architecture.md`) — wird um die Entkopplung/Benennung ergänzt (siehe [[credential-key-flow]]).
