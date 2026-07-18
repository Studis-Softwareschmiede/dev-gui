---
id: anthropic-oauth-vault
title: Abo-OAuth-Credentials im Tresor für offizielle Usage-Werte (mit Auto-Refresh)
status: active
area: einstellungen
version: 1
spec_format: use-case-2.0
---

# Spec: Abo-OAuth-Credentials im Tresor für offizielle Usage-Werte  (`anthropic-oauth-vault`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck

`GET /api/usage` ([[usage-official-values]], gelandet) fällt **im Container dauerhaft** auf `source: "estimated"` zurück: das dort genutzte Container-Token (`CLAUDE_CODE_OAUTH_TOKEN`, langlebiges Setup-Token) wird vom Anthropic-Usage-Endpunkt mit **HTTP 403 „OAuth token does not meet scope requirement `user:profile`"** abgelehnt. Die **interaktiven Abo-OAuth-Credentials** (macOS-Keychain „Claude Code-credentials", JSON `claudeAiOauth` mit `accessToken`/`refreshToken`/`expiresAt`/`scopes` inkl. `user:profile`) funktionieren gegen denselben Endpunkt (live 2026-07-18 verifiziert, HTTP 200, Schema passt zum bestehenden `src/AnthropicUsageClient.js`).

Diese Spec legt die Abo-OAuth-Credentials **verschlüsselt in den bestehenden `CredentialStore`** (`secrets.enc.json`, [[settings-credentials]]-Regeln, ADR-007), macht sie über die **Settings-Ansicht** write-only pflegbar und lässt `GET /api/usage` sie **vorrangig** verwenden. Da Abo-Access-Tokens nach Stunden verfallen, erneuert das Backend sie bei Ablauf/401/403 **einmalig on-demand** per `refresh_token` und schreibt die erneuerten Werte verschlüsselt zurück. So liefert die goldene-Münze-Anzeige auch im Container die **offiziellen** Prozent-/Reset-Werte, ohne Klartext-Secret im Repo/Image.

## Kontext & Grenzen (bindend)

**Doktrin unverändert.** Kein `ANTHROPIC_API_KEY`, kein Inferenz-/Messages-API-Aufruf. Diese Spec fügt **keinen** neuen ausgehenden Anthropic-Aufruf-Typ hinzu außer dem bereits per **ADR-022** freigegebenen read-only Usage-Abruf **und** dem zugehörigen **OAuth-Token-Refresh** (Voraussetzung dafür, dass der read-only Abruf mit einem gültigen Abo-Token überhaupt gelingt). `TokenUsageMeter` und die gesamte Fallback-Kette aus [[usage-official-values]] (AC5–AC7) bleiben **unangetastet**.

**Diese Spec schreibt [[usage-official-values]] NICHT um.** Sie referenziert und erweitert sie nur um die Token-Herkunft (Tresor statt/vor Env) + den Refresh-Flow. Das interne `GET /api/usage`-Antwort-Modell (`official`/`estimated`/`unavailable`) bleibt Wort für Wort gültig.

**Refresh-Endpunkt ist NICHT als Vertrag fixiert (Resolution R4).** URL, `client_id` und Body-Form des OAuth-Token-Refresh ermittelt der `coder`/`architekt` **defensiv gegen die lokal installierte `@anthropic-ai/claude-code`-Binary** (analog zum Vorgehen bei S-365 / `AnthropicUsageClient.js`, dort per `strings` gegen die Binary verifiziert). Diese Spec schreibt kein konkretes Upstream-Schema fest; sie fordert nur den **festen Host** (AC9) und das **defensive Degradieren** bei Abweichung (AC6/AC7).

## Verhalten

1. **Tresor-Katalog.** Der `CredentialStore` kennt eine neue Integration `anthropic-oauth` mit den **geheimen** Feldern `access_token` und `refresh_token` (write-only, verschlüsselt in `entries`) sowie dem **nicht-geheimen** Wert `expires_at` (Unix-Millisekunden — der Ablaufzeitpunkt des Access-Tokens). Setzen/Überschreiben/Löschen folgen den bestehenden write-only-Regeln aus [[settings-credentials]].
2. **Nicht-geheime Ablaufanzeige.** Ein Lesepfad liefert den Status der beiden Token-Felder (`set`/`unset`) **und** `expires_at` (Unix-ms, für die Anzeige) — **nie** einen Token-Klartext.
3. **Token-Auflösung in `GET /api/usage`.** Reihenfolge für den offiziellen Abruf:
   (a) Tresor-`access_token`, falls hinterlegt **und** nicht abgelaufen (bzw. nach erfolgreichem Refresh),
   (b) sonst das bisherige Env-`CLAUDE_CODE_OAUTH_TOKEN` (Bestandsverhalten),
   (c) sonst die Fallback-Kette aus [[usage-official-values]] (`estimated` → `unavailable`).
4. **Ablauf-Prüfung.** Ein Tresor-`access_token` gilt als abgelaufen, wenn `now ≥ expires_at` (abzüglich einer kleinen Sicherheitsspanne, coder-definiert — Richtwert 60 s). Ein als abgelaufen erkanntes Token wird **nicht** blind gesendet, sondern löst zuerst den Refresh (Regel 5) aus.
5. **On-demand-Refresh (einmalig).** Ist das Tresor-`access_token` abgelaufen (Regel 4) **oder** antwortet der Usage-Endpunkt mit **401/403** auf ein tresor-basiertes Token, erneuert das Backend **genau einmal** per `refresh_token` gegen den festen Anthropic-OAuth-Token-Endpunkt, schreibt `access_token`/`refresh_token`/`expires_at` **verschlüsselt zurück** (atomar, bestehende Store-Write-Mechanik inkl. Backup-Hook) und wiederholt den Usage-Abruf **einmal** mit dem neuen Token.
6. **Refresh-Fehler ist nicht destruktiv.** Scheitert der Refresh (Netz/Timeout/HTTP ≥ 400/ungültiger `refresh_token`), bleibt der Tresor-Eintrag **unverändert** (kein Löschen); die Route degradiert entlang der bestehenden Kette (Env-Token → `estimated` → `unavailable`) und schreibt einen **secret-freien** Audit-Eintrag.
7. **Kein Refresh-Loop.** Höchstens **ein** Refresh-Versuch je `GET /api/usage`-Request; ein erneutes 401/403 **nach** dem Refresh löst **keinen** weiteren Refresh aus, sondern die Fallback-Kette.
8. **Settings-GUI.** Eine neue Sektion „Claude-Abo (Nutzungsanzeige)" bietet write-only-Eingabefelder für `access_token` + `refresh_token` (bestehendes `CredentialField`-Muster) und zeigt den Status (gesetzt/nicht gesetzt je Feld + `expires_at` menschenlesbar). Der eingegebene Klartext wird nach dem Speichern **nie** wieder angezeigt.
9. **Security-Floor (hart).** Die Token-Werte erscheinen **nie** in Log/Audit/Response/WS/Frontend-Bundle/Argv; sie werden ausschließlich als ausgehender `Authorization`-Header (Usage) bzw. Refresh-Request-Body verwendet. Der Refresh-Request geht **nur** an den festen Anthropic-Host. **Keine** neue Env-Variable.

## Acceptance-Kriterien

- **AC1** — **Tresor-Katalog.** Der `CredentialStore` kennt die Integration `anthropic-oauth` mit den geheimen Feldern `access_token`, `refresh_token` (verschlüsselt in `entries`, write-only) und dem nicht-geheimen `expires_at` (Unix-ms). Setzen/Überschreiben/Löschen folgen den write-only-/Masken-Regeln aus [[settings-credentials]] AC2/AC3. Testbar: PUT speichert; die Status-Liste zeigt `set` **ohne** Klartext; DELETE setzt `unset`.
- **AC2** — **Nicht-geheime Ablaufanzeige.** Ein Lesepfad liefert je Token-Feld den Status (`set`/`unset`) **und** `expires_at` (Unix-ms, falls gesetzt) — **nie** einen Token-Klartext. Testbar: Response enthält `expires_at` + Status, aber keinen `access_token`/`refresh_token`-Wert.
- **AC3** — **Token-Auflösung (Priorität).** `GET /api/usage` nutzt für den offiziellen Abruf (a) das Tresor-`access_token` (gesetzt + nicht abgelaufen bzw. nach Refresh), sonst (b) `CLAUDE_CODE_OAUTH_TOKEN`, sonst (c) die Fallback-Kette. Testbar (gestubbt): gültiges Tresor-Token → Tresor-Token im Authorization-Header; kein Tresor-Token, aber Env → Env-Token; keins von beiden → `estimated`.
- **AC4** — **Ablauf-Prüfung.** Ein Tresor-`access_token` mit `now ≥ expires_at` (abzüglich Sicherheitsspanne) gilt als abgelaufen und wird **nicht** direkt gesendet, sondern löst den Refresh (AC5) aus. Testbar: `expires_at` in der Vergangenheit → kein Usage-Call mit dem alten Token, stattdessen Refresh-Pfad.
- **AC5** — **On-demand-Refresh + Rückschreiben.** Bei abgelaufenem Tresor-Token (AC4) **oder** bei 401/403 auf ein tresor-basiertes Token führt das Backend **genau einen** Refresh gegen den festen OAuth-Token-Endpunkt per `refresh_token` aus; bei Erfolg werden `access_token`/`refresh_token`/`expires_at` **verschlüsselt** in den Tresor zurückgeschrieben (atomar, inkl. Backup-Hook) und der Usage-Abruf **einmal** mit dem neuen Token wiederholt. Testbar: abgelaufenes Token + Refresh-Stub liefert neue Tokens → neue Werte persistiert, Usage-Call mit neuem `access_token` wiederholt.
- **AC6** — **Refresh-Fehler nicht destruktiv.** Scheitert der Refresh (Netz/Timeout/HTTP ≥ 400/ungültiger `refresh_token`), bleibt der Tresor-Eintrag **unverändert**; die Route degradiert entlang der bestehenden Kette und schreibt einen secret-freien Audit-Eintrag. Testbar: Refresh-Stub scheitert → Tresor-Werte unverändert, Antwort `estimated` (bzw. `official` via Env, falls verfügbar), Audit ohne Token.
- **AC7** — **Kein Refresh-Loop.** Höchstens **ein** Refresh-Versuch je Request; ein erneutes 401/403 nach Refresh führt **nicht** zu einem weiteren Refresh, sondern zur Fallback-Kette. Testbar: Refresh liefert ein Token, das erneut 401 ergibt → genau **ein** Refresh-Call, danach Fallback.
- **AC8** — **Secret-Disziplin (security).** `access_token` und `refresh_token` erscheinen **nicht** im Code als Literal, **nicht** im Antwort-Body (`GET /api/usage`, Credential-Liste/Status), **nicht** in Logs, **nicht** in Audit-Einträgen, **nicht** im WS-Stream und **nicht** im Frontend-Bundle; sie werden nur als ausgehender Authorization-Header (Usage) bzw. Refresh-Request-Body verwendet. Testbar: Log-/Audit-Spy sieht auf keinem Pfad (Erfolg/Refresh/Fehler) einen Token-Wert; Response-Bodies enthalten keinen Token.
- **AC9** — **Fester Host, keine neue Env (security).** Der Refresh-Request geht **ausschließlich** an den festen Anthropic-OAuth-Host (kein nutzer-konfigurierbares/abgeleitetes Ziel, kein SSRF-Vektor); es wird **keine** neue Env-Variable eingeführt. Testbar: Refresh-Ziel-URL ist eine Konstante (kein Nutzer-Input); ein Grep zeigt keine neue `process.env`-Variable.
- **AC10** — **Settings-GUI-Sektion.** Eine neue Sektion „Claude-Abo (Nutzungsanzeige)" bietet write-only-Felder für `access_token` + `refresh_token` (`CredentialField`-Muster) und zeigt Status (gesetzt/nicht gesetzt je Feld) + `expires_at` menschenlesbar (bzw. „kein Ablaufdatum" wenn ungesetzt). Eingegebener Klartext wird nie erneut angezeigt. Testbar (Komponenten-Test): mit Metadaten-Mock rendern die Felder write-only, Status + `expires_at` werden gezeigt, kein Token-Klartext im DOM.
- **AC11** — **GUI-Mutation admin-gated + auditiert (security).** Setzen/Löschen der beiden Token-Felder läuft über den bestehenden AccessGuard + Admin-Gate ([[settings-credentials]] AC6/AC7) und erzeugt einen Audit-Eintrag **ohne** Klartext. Testbar: unberechtigt → 403; berechtigte Mutation → Audit-Eintrag ohne Token.
- **AC12** — **Bestandsverhalten unverändert (Regression).** Ohne hinterlegte Tresor-Tokens verhält sich `GET /api/usage` **exakt wie heute** (`CLAUDE_CODE_OAUTH_TOKEN` primär → `estimated`-Fallback → `unavailable`); die Acceptance-Kriterien AC1–AC9 aus [[usage-official-values]] bleiben grün. Testbar: bestehende `usage`-Tests laufen unverändert grün, wenn der Tresor keine `anthropic-oauth`-Tokens enthält.

## Verträge

**Tresor-Katalog (Erweiterung `CredentialStore.CREDENTIAL_CATALOG`):**
```
anthropic-oauth: ['access_token', 'refresh_token']   // Secrets, verschlüsselt in entries (write-only)
```
`expires_at` (Unix-ms, nicht-geheim) wird **nicht** verschlüsselt behandelt: es darf für die Anzeige zurückgegeben werden. **Ablage-Ort ist Implementierungsdetail des `coder`/`architekt`** (Resolution R2) — Empfehlung: `meta`-Block (analog Workspace-/Vault-Pfad), damit die Status-Anzeige `expires_at` **ohne** Entschlüsselung der Secrets lesen kann. Constraint (bindend): `expires_at` ist lesbar; die Tokens sind es **nie**.

**Pflege-Endpunkte:** die bestehenden `PUT`/`DELETE /api/settings/credentials/anthropic-oauth/{access_token|refresh_token}` ([[settings-credentials]]-Verträge) — kein neuer Mutations-Endpunkt-Typ. Für `expires_at` + Status genügt der bestehende Listen-/Status-Lesepfad, erweitert um `expires_at` (nicht-geheim).

**`GET /api/usage`:** Endpunkt, Antwort-Modell (`official`/`estimated`/`unavailable`) und Montage (`order = 400`) **unverändert** gegenüber [[usage-official-values]]. Neu ist ausschließlich die **Token-Quelle** (Tresor vor Env) + der Refresh-Vorlauf.

**Refresh (inoffiziell, NICHT als Vertrag fixiert):** OAuth-Token-Refresh gegen den festen Anthropic-Host; exakte URL/`client_id`/Body ermittelt der `coder`/`architekt` gegen die lokale Claude-Code-Binary (Resolution R4). Erfolgs-Payload liefert mindestens ein neues `access_token` + `expires_at` (und i. d. R. ein rotiertes `refresh_token`); der Adapter ist die **einzige** Stelle, die dieses Upstream-Schema kennt (isolierte Bruchstelle, analog `AnthropicUsageClient.js`).

## Edge-Cases & Fehlerverhalten

- **`access_token` gesetzt, `expires_at` fehlt/unparsebar:** als abgelaufen behandeln → Refresh-Versuch (falls `refresh_token` vorhanden), sonst Env-Fallback.
- **`refresh_token` fehlt, `access_token` abgelaufen:** kein Refresh möglich → Env-Fallback, Tresor unverändert.
- **Store gesperrt (kein Master-Key):** Tresor-Tokens nicht lesbar → Env-Fallback (Bestandsverhalten AC12), secret-freier Warn-Log, kein Crash.
- **`expires_at` weit in der Vergangenheit:** dennoch **genau ein** Refresh-Versuch (AC7), dann Fallback.
- **Refresh-Timeout:** beschränktes Timeout (Richtwert wie Usage-Fetch, 8 s) → wie Refresh-Fehler (AC6).
- **Konkurrierende Requests lösen gleichzeitig Refresh aus:** kein Crash, kein Token-Leak; die Store-Write-Mechanik ist bereits mutex-serialisiert. Doppel-Refresh ist tolerierbar (letzter Write gewinnt) — eine engere Serialisierung ist optional (coder-Ermessen).
- **Usage-Endpunkt 200, aber unbrauchbares Schema:** unverändert [[usage-official-values]] AC7 (Adapter degradiert auf `estimated`).

## NFRs

- **Security (Floor + explizit):** kein Token in Code/Log/Audit/Body/WS/Bundle/Argv (AC8); Refresh nur an den festen Anthropic-Host (AC9, kein SSRF); keine neue Env-Variable (AC9); Store-at-rest-Verschlüsselung + write-only-Boundary unverändert ([[settings-credentials]]).
- **Bounded write (bewusste Ausnahme, Resolution R3):** [[usage-official-values]] beschreibt `GET /api/usage` als read-only/kein Persistieren. Diese Spec führt einen **eng begrenzten** Seiteneffekt ein — das **Rückschreiben rotierter Tokens beim Refresh** (AC5). Das ist der **einzige** erlaubte Schreib-Seiteneffekt der Route; ohne Refresh bleibt sie read-only.
- **Resilienz:** kein Pfad (Erfolg/Refresh/Fehler) darf die Route werfen lassen; beschränktes Timeout gegen hängende Refresh-/Usage-Aufrufe; höchstens ein Refresh je Request (AC7).
- **A11y:** die neue Settings-Sektion folgt dem bestehenden Formularfeld-/Fehler-/Fokus-Muster ([[settings-credentials]] NFR A11y).

## Nicht-Ziele

- **Kein** `ANTHROPIC_API_KEY`, **kein** Inferenz-/Messages-API-Aufruf (Doktrin unverändert — nur der ADR-022-Usage-Abruf + der zugehörige Refresh).
- **Keine** Umschreibung von [[usage-official-values]] (nur Referenz + Token-Herkunft/Refresh ergänzt).
- **Keine** Änderung an `TokenUsageMeter`/der Fallback-Kette.
- **Kein** proaktiver/Hintergrund-Refresh, **kein** Polling — der Refresh passiert ausschließlich on-demand beim Request, wenn abgelaufen/401/403.
- **Kein** Klartext-Credential in Repo/Image/GitHub oder als Env/Datei — ausschließlich im verschlüsselten `CredentialStore`.
- **Keine** neue Env-Variable.

## Abhängigkeiten

- [[usage-official-values]] — der bestehende Usage-Pfad (ADR-022), dessen Token-Quelle diese Spec erweitert (Fallback-Kette bleibt).
- [[settings-credentials]] — der write-only `CredentialStore` + die Pflege-Endpunkte/Muster (ADR-007), um die neue Integration erweitert.
- [[claude-code-oauth-token]] — Herkunft/Bezug des Abo-OAuth-Tokens (Bestandspfad Env).
- [[access-and-guardrails]] — Access-Mauer + Audit + Identitätsauswertung (GUI-Mutation, AC11).
- **Extern:** inoffizieller Anthropic-Usage- + OAuth-Token-Refresh-Endpunkt (Bruch-Risiko → defensives Degradieren ist Pflicht).

## Resolutions (ohne Betreiber-Rückfrage konservativ getroffen — Subagent-Lauf ohne `AskUserQuestion`, 2026-07-18)

- **R1 — Bereich `einstellungen` (Grenzfall vs. `nachtwaechter`).** Die neue Fähigkeit ist im Kern **Credential-Ablage im Tresor + Settings-GUI-Sektion + Credential-Lebenszyklus (Refresh)** — drei der vier Bausteine fallen unter „Einstellungen: Settings-Panel, **Credentials**, Workspace-Pfad" (areas.yaml). Die Änderung an `usage.js` ist eine **dünne Konsumenten-Verdrahtung** einer bestehenden `nachtwaechter`-Fähigkeit (analog dazu, wie `CloudflareApi`/`VpsProvisioner` Tresor-Creds store-intern konsumieren, ohne die Credential-Fähigkeit in ihren Bereich zu verschieben). Die nächste Schwester-Spec ist `settings-credentials` (area `einstellungen`), deren Muster diese Spec fast 1:1 fortführt. Soll die Folge-Arbeit stattdessen unter `nachtwaechter` (Konsistenz mit dem Eltern-Feature F-084 der Usage-Werte) laufen, ist das eine bewusste Umentscheidung — dann wandert Feature/Spec-`area` nach `nachtwaechter`.
- **R2 — `expires_at`-Ablageort offen gelassen.** Verhalten (lesbar; Tokens nie lesbar) ist fixiert, der Speicherort (`meta`-Block empfohlen vs. verschlüsselter `entries`) bleibt `coder`/`architekt`-Ermessen.
- **R3 — Bounded write als bewusste Ausnahme zur read-only-NFR von `usage-official-values`.** Das Rückschreiben rotierter Tokens beim Refresh ist der einzige erlaubte Schreib-Seiteneffekt der Route (siehe NFR).
- **R4 — Refresh-Endpunkt nicht als Vertrag fixiert.** URL/`client_id`/Body ermittelt der `coder` defensiv gegen die lokale Claude-Code-Binary (analog S-365).
- **R5 — Story-Schnitt = 2 Stories** (Backend: Tresor + Token-Auflösung + Refresh; Frontend: Settings-Sektion). Frontend hängt vom Backend ab (braucht Katalog-Feld + Status-Lesepfad).
- **R6 — Ablauf-Sicherheitsspanne** (Richtwert 60 s vor `expires_at`) `coder`-definiert.
