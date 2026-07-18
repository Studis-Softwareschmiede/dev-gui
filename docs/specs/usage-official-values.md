---
id: usage-official-values
title: Token-Nutzungs-Anzeige zeigt offizielle Anthropic-Nutzungswerte (statt lokaler Schätzung)
status: active
area: nachtwaechter
version: 1
spec_format: use-case-2.0
---

# Spec: Token-Nutzungs-Anzeige zeigt offizielle Anthropic-Nutzungswerte  (`usage-official-values`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck

Die Token-Nutzungs-Anzeige (goldene Münze in der Kopfleiste → `client/src/UsageOverlay.jsx`, gespeist von `GET /api/usage` in `src/routers/usage.js`) zeigt heute nur eine **grobe lokale Schätzung** (`estimated: true`, reine Output-Token-Summierung aus den Session-Transcripts via `TokenUsageMeter`). Diese Spec ersetzt den Anzeige-**Primärwert** durch die **offiziellen Anthropic-Nutzungswerte** — genau die Zahlen, die Claude Code in seinem `/usage`-Dialog zeigt (Prozent verbraucht + Reset-Zeitpunkt je Fenster/Modell): abgerufen über **denselben** inoffiziellen Anthropic-Usage-Endpunkt, den Claude Code intern mit dem **Abo-OAuth-Token** anspricht. Es findet **keine eigene Umrechnung** mehr statt — nur **Durchreichen** der offiziellen Prozent-/Reset-/Spend-Werte. Der bestehende lokale Schätzpfad bleibt als **Fallback** erhalten (Degradation, nicht Ersatz), damit die Anzeige bei einem Endpunkt-Bruch nicht wertlos wird.

## Kontext & Grenzen (bindend)

**Warum der Endpunkt bisher bewusst vermieden wurde.** `src/routers/usage.js` (Kopf-Kommentar) und der ursprüngliche Direkt-Commit (#373) haben den Endpunkt-Abruf **absichtlich** ausgelassen, weil der Endpunkt **inoffiziell/nicht dokumentiert** ist und sich **ändern kann** — ein Fehlgriff dort ist teurer (Bruch, Fehlverhalten) als der Nutzen des exakten Prozentwerts. Diese Spec hebt die Auslassung auf, **macht die Bruch-Resilienz aber zur Kern-Anforderung** (Fallback + Schema-Validierung + ehrlicher Fehler-Zustand, siehe AC5–AC8).

**Konzept-/Architektur-Verhältnis — offene Entscheidung, an `architekt`/Owner eskaliert (siehe Lauf-Output).** `docs/concept.md` (Nicht-Ziel, Z. 18) nennt „**Kein** Anthropic-API-Key und **kein** `claude -p`"; die Doktrin „Engine = Abo, nicht API" (Z. 14) begründet dies mit **Kosten/separatem Kontingent**. Der hier eingeführte Abruf ist:
- **kein** Inferenz-/Messages-API-Aufruf (verbraucht **keine** Inferenz-Tokens, **keine** Pro-Token-Kosten, **kein** separates Kontingent),
- **kein** `ANTHROPIC_API_KEY` (nutzt das **Abo-OAuth-Token** — dieselbe Auth wie der bestehende Agenten-Pfad, [[claude-code-oauth-token]]),
- exakt der **read-only Usage-Reporting-Aufruf**, den Claude Code selbst macht.
Damit liegt er **im Intent** der Doktrin (kostenfrei, OAuth statt API-Key), führt aber eine **neue ausgehende Anthropic-Integration** (neue Trust-Boundary) ein, die `docs/architecture.md` heute nicht benennt. **Resolution U1 (2026-07-18, ohne Betreiber-Rückfrage konservativ getroffen — Subagent-Lauf ohne `AskUserQuestion`):** Dies wird **nicht** als harter Konzept-Widerspruch gewertet (Owner-Eskalation nach Bereichs-Gate AC5 nur bei echtem Widerspruch), sondern als **architektur-relevante Erweiterung, die eine ADR-Bestätigung durch `architekt`/Owner braucht**, bevor gebaut wird. Ist der Abruf gegen das Abo-Token unerwünscht, ist das eine bewusste Umentscheidung — dann entfällt diese Spec (Rückfall auf reine Schätzung). Der `coder` baut erst nach ADR-Bestätigung; die ADR-Aufnahme in `docs/architecture.md` ist `architekt`-Scope (nicht `requirement`).

**Endpunkt-Schema ist NICHT verifiziert.** Weder URL noch Antwort-Schema des Usage-Endpunkts sind in diesem Lauf gegen einen echten Aufruf verifiziert. Diese Spec **behauptet kein konkretes Upstream-Schema als Fakt**, sondern definiert (a) das **interne** `GET /api/usage`-Antwort-Modell (Vertrag für das Frontend) und (b) einen **Adapter**, der das reale Upstream-Payload defensiv auf dieses Modell abbildet und bei Abweichung degradiert (AC7). Die exakte Endpunkt-URL + Upstream-Feldnamen ermittelt der `coder`/`architekt` beim Bau gegen die echte Antwort (z. B. durch Beobachtung des `/usage`-Aufrufs von Claude Code) — sie sind **Implementierungs-Detail**, kein hier festgeschriebener Vertrag.

## Verhalten

1. **Primärpfad (offiziell).** `GET /api/usage` ruft den Anthropic-Usage-Endpunkt mit dem Abo-OAuth-Token ab, validiert das Payload und antwortet mit `source: "official"` samt Prozent-/Reset-Werten (Session-5h + Wochenlimits, siehe Vertrag).
2. **Session-Fenster.** Die aktuelle 5h-Session wird als **Prozent verbraucht** + **Reset-Zeitpunkt** (ISO-8601) durchgereicht — 1:1 aus dem Endpunkt, keine eigene Berechnung.
3. **Wochenlimits.** „Alle Modelle" (aggregiert) als Prozent + Reset **und** je Modell (z. B. `Fable`) als Prozent + Reset — als Liste, so vollständig wie der Endpunkt sie liefert.
4. **Spend/Guthaben (optional).** Liefert der Endpunkt ein Nutzungsguthaben/Spend, wird es durchgereicht; liefert er es **nicht**, fehlt das Feld in der Antwort (**nie** ein erfundener Wert).
5. **Fallback bei Endpunkt-Ausfall.** Ist der Endpunkt nicht erreichbar (Netz/Timeout/HTTP-Fehler/fehlende Auth) **oder** liefert er ein unerwartetes Schema, degradiert `GET /api/usage` auf den bestehenden `TokenUsageMeter`-Schätzwert und antwortet mit `source: "estimated"` (rohe Output-Token-Zahlen, **keine** %/Reset-Behauptung — heutiges Verhalten).
6. **Ehrlicher Fehler-Zustand.** Scheitert **auch** die Schätzung (z. B. unlesbares Transcript-Verzeichnis liefert 0, aber ein interner Fehler tritt auf), antwortet die Route mit `source: "unavailable"` und **ohne** erfundene Zahlen.
7. **Secret-Disziplin (Floor).** Das OAuth-Token wird zum Abruf-Zeitpunkt aus der lokalen Abo-OAuth-Quelle bezogen und **ausschließlich** als Authorization-Header der ausgehenden Anfrage verwendet — es erscheint **nie** in Code-Literalen, Logs, Audit-Einträgen oder im Antwort-Body.
8. **`TokenUsageMeter` bleibt.** Der Meter (`src/TokenUsageMeter.js`, [[token-usage-meter]]) wird **nicht** entfernt — er ist der Fallback-Pfad und bleibt zusätzlich Zulieferer für [[night-budget-guard]].
9. **Frontend zeigt Herkunft transparent.** Das Overlay stellt offizielle %/Reset-Werte dar, kennzeichnet einen `estimated`-Fallback klar als „geschätzt" (ohne %/Reset) und zeigt bei `unavailable` einen ehrlichen Fehler-Hinweis — nie eine geschätzte Zahl als offiziell.

## Acceptance-Kriterien

- **AC1** — `GET /api/usage` ruft bei verfügbarem OAuth-Token den Anthropic-Usage-Endpunkt ab und liefert bei Erfolg `{ source: "official", generatedAt, session, week, spend? }`. Testbar: mit gestubbtem HTTP-Client, der ein valides Usage-Payload liefert, antwortet die Route `200` mit `source: "official"` und den gemappten Werten.
- **AC2** — Die Antwort enthält `session: { percentUsed: <0..100>, resetAt: <ISO-8601> }` für das laufende 5h-Fenster, 1:1 aus dem Endpunkt gemappt (keine eigene Fenster-/Prozent-Berechnung). Testbar: die gestubbten Upstream-Session-Felder erscheinen unverändert im gemappten Ergebnis.
- **AC3** — Die Antwort enthält `week: { allModels: { percentUsed, resetAt }, perModel: [ { model, percentUsed, resetAt }, … ] }` — „Alle Modelle" plus je-Modell-Einträge, so vollständig wie der Endpunkt sie liefert. Testbar: ein Upstream-Payload mit „Alle Modelle" + zwei Modellen ergibt `allModels` + zwei `perModel`-Einträge.
- **AC4** — `spend` wird **nur** aufgenommen, wenn der Endpunkt einen Spend-/Guthaben-Wert liefert; fehlt er upstream, fehlt `spend` in der Antwort (kein `null`-Platzhalter, kein erfundener Wert). Testbar: Payload ohne Spend → Antwort ohne `spend`; Payload mit Spend → Antwort mit dem Wert.
- **AC5** — **Fallback (Endpunkt-Ausfall).** Bei Netzfehler/Timeout/HTTP-≥400/fehlendem OAuth-Token antwortet die Route `200` mit `source: "estimated"` und den `TokenUsageMeter`-Rohzahlen (`session.outputTokens`, `week.outputTokens`) — **ohne** `percentUsed`/`resetAt`. Testbar: HTTP-Stub wirft/liefert 500 → Antwort `source: "estimated"` mit Token-Zahlen, keine Prozentfelder.
- **AC6** — **Ehrlicher Fehler-Zustand.** Scheitert zusätzlich der Schätzpfad mit einem internen Fehler, antwortet die Route mit `source: "unavailable"` und **ohne** erfundene Zahlen (weder Prozent noch Token). Testbar: HTTP-Stub scheitert **und** Meter-Stub wirft → Antwort `source: "unavailable"`, keine Zahlwerte.
- **AC7** — **Schema-Validierung/Adapter.** Ein Upstream-Payload mit unerwarteter Struktur (fehlende Pflichtfelder, falsche Typen) führt **nie** zu einem Crash der Route: fehlende/ungültige Felder degradieren pro Feld, und ein unbrauchbares Gesamt-Payload löst denselben Fallback wie AC5 aus (`source: "estimated"`). Testbar: Payload mit Müll-Struktur → Route wirft nicht, antwortet `source: "estimated"` (oder mappt vorhandene Felder + lässt fehlende weg).
- **AC8** — **Secret-Disziplin (security).** Der OAuth-Token-Wert erscheint nicht im Code als Literal, nicht im Antwort-Body (`GET /api/usage`), nicht in Logs und nicht in Audit-Einträgen; er wird nur als ausgehender Authorization-Header verwendet. Testbar: Antwort-Body enthält keinen Token; ein Log-/Audit-Spy sieht den Token-Wert bei keinem Pfad (Erfolg, Fallback, Fehler).
- **AC9** — **`TokenUsageMeter` bleibt erhalten.** `src/TokenUsageMeter.js` bleibt vorhanden und wird als Fallback-Zulieferer von `GET /api/usage` genutzt; kein anderer Konsument (z. B. [[night-budget-guard]]) verliert seinen Zugriff. Testbar: der Meter wird weiterhin importiert/aufgerufen; bestehende Meter-Tests bleiben grün.
- **AC10** — **Frontend: offizielle Werte.** Bei `source: "official"` zeigt das Overlay je Fenster den **Prozentwert** + den **Reset-Zeitpunkt** (lokalisiert formatiert) für Session, „Alle Modelle" und jedes Modell; `spend` wird gezeigt, wenn vorhanden. Testbar (Komponenten-Test): mit gemocktem `official`-Payload erscheinen Prozent + Reset-Zeit für Session + Wochenlimits.
- **AC11** — **Frontend: Herkunft transparent.** Bei `source: "estimated"` kennzeichnet das Overlay die Werte klar als geschätzt (heutiger Hinweistext) und zeigt **keine** Prozent-/Reset-Werte; bei `source: "unavailable"` erscheint ein ehrlicher Fehler-/Leer-Hinweis statt Zahlen. Testbar: Mock `estimated` → „geschätzt"-Hinweis, keine %; Mock `unavailable` → Fehler-/Leer-Hinweis.
- **AC12** — **Frontend: A11y unverändert.** Das bestehende Dialog-Verhalten (`role=dialog`/`aria-modal`, ESC schließt, Fokus-Falle, Fokus-Rückgabe an den Auslöser, Aktualisieren-Knopf) bleibt bei allen drei Zuständen erhalten. Testbar: die bestehenden Overlay-A11y-Tests bleiben grün, neue Zustände brechen sie nicht.

## Verträge

**Endpunkt:** `GET /api/usage` (unverändert montiert, `order = 400`).

**Antwort-Modell (intern, Vertrag fürs Frontend):**
```jsonc
// source: "official"
{
  "source": "official",
  "generatedAt": "<ISO-8601>",
  "session": { "percentUsed": <number 0..100>, "resetAt": "<ISO-8601>" },
  "week": {
    "allModels": { "percentUsed": <number>, "resetAt": "<ISO-8601>" },
    "perModel": [ { "model": "<string>", "percentUsed": <number>, "resetAt": "<ISO-8601>" } ]
  },
  "spend": { /* nur falls upstream vorhanden; Form folgt dem Endpunkt */ }   // OPTIONAL
}
// source: "estimated" (Fallback, heutiges Verhalten)
{
  "source": "estimated",
  "generatedAt": "<ISO-8601>",
  "session": { "outputTokens": <int>, "windowHours": 5 },
  "week":    { "outputTokens": <int>, "windowDays": 7 }
}
// source: "unavailable"
{ "source": "unavailable", "generatedAt": "<ISO-8601>" }
```
> **Hinweis:** `source` löst das bisherige `estimated: true`-Flag ab (das Frontend unterscheidet jetzt drei Zustände statt zwei). Numerische Formatierung/Lokalisierung (`de-CH`) bleibt Frontend-Sache.

**Upstream (inoffiziell, NICHT als Vertrag festgeschrieben):** Anthropic-Usage-Endpunkt, Authorization über das Abo-OAuth-Token; exakte URL + Feldnamen ermittelt der `coder`/`architekt` gegen die echte Antwort. Der Adapter bildet das reale Payload auf das interne Modell oben ab und ist die **einzige** Stelle, die das Upstream-Schema kennt (isolierte Bruchstelle).

**OAuth-Token-Herkunft:** dieselbe Abo-OAuth-Quelle, die die Agenten-Sessions nutzen ([[claude-code-oauth-token]] — `CLAUDE_CODE_OAUTH_TOKEN` bzw. die lokale Claude-Credential-Ablage unter `~/.claude/`). **Kein** `ANTHROPIC_API_KEY`. Bezug zur Laufzeit, kein Persistieren.

## Edge-Cases & Fehlerverhalten

- **OAuth-Token fehlt/leer:** kein Abruf-Versuch mit leerem Header — direkt Fallback `source: "estimated"` (AC5).
- **Endpunkt-Timeout:** ausgehende Anfrage hat ein beschränktes Timeout; Überschreitung → Fallback (AC5), keine hängende Route.
- **HTTP 401/403 (Token abgelaufen/ungültig):** wie Endpunkt-Ausfall → Fallback `source: "estimated"` (AC5); der Token-Wert wird dabei **nicht** geloggt (AC8).
- **HTTP 200, aber unbekanntes/geändertes Schema:** Adapter mappt, was er erkennt; ist nichts Brauchbares dabei → Fallback `source: "estimated"` (AC7).
- **Teil-Payload (Session ok, Wochenliste fehlt):** vorhandene Felder werden gemappt, fehlende weggelassen; das Frontend zeigt nur, was vorhanden ist (AC7/AC10).
- **Meter liefert 0 (kein Transcript):** legitimer Wert `0`, kein Fehler — `source: "estimated"` mit `0`.

## NFRs

- **Security (Floor + explizit):** kein Token in Code/Log/Audit/Body (AC8); ausgehende Anfrage nur an den Anthropic-Usage-Host (keine frei konfigurierbare Ziel-URL aus Nutzer-Eingabe); Route bleibt read-only (kein Seiteneffekt, kein Persistieren). Die Route liegt hinter Cloudflare Access wie der Rest der App.
- **Resilienz:** kein Pfad (Erfolg/Fallback/Fehler) darf die Route werfen lassen; beschränktes Timeout gegen hängende Upstream-Aufrufe.
- **Performance:** ein Auto-Load je Overlay-Öffnung + manuelles „Aktualisieren" (heutiges Verhalten); kein Polling. Ein einzelner Upstream-Aufruf je Request.
- **A11y:** unverändert gegenüber dem bestehenden Overlay (AC12).

## Nicht-Ziele

- **Keine** eigene Prozent-/Fenster-Berechnung aus Tokens — die offiziellen Werte werden nur durchgereicht.
- **Keine** Persistenz/History der Nutzungswerte (ADR-005-Linie: live, kein Store).
- **Kein** `ANTHROPIC_API_KEY`, **kein** Inferenz-/Messages-API-Aufruf, **kein** Polling/Hintergrund-Refresh.
- **Keine** Entfernung des `TokenUsageMeter` (bleibt Fallback + [[night-budget-guard]]-Zulieferer).
- **Keine** ADR-Änderung an `docs/architecture.md` durch diese Spec — das ist `architekt`-Scope (siehe Resolution U1).

## Abhängigkeiten

- [[token-usage-meter]] — Fallback-Zulieferer (bleibt erhalten).
- [[claude-code-oauth-token]] — Herkunft des Abo-OAuth-Tokens (Auth des Abrufs).
- [[night-budget-guard]] — weiterer Konsument des `TokenUsageMeter` (darf nicht brechen).
- **Extern:** inoffizieller Anthropic-Usage-Endpunkt (Bruch-Risiko → Fallback ist Pflicht).
- **Erledigt (ADR-022, 2026-07-18):** Owner hat die ausgehende Usage-Integration mit dem Abo-OAuth-Token bestätigt (Resolution U1 aufgelöst) — `coder` hat grünes Licht.
