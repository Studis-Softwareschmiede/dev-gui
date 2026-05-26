---
id: access-and-guardrails
title: Access-Gate + Sicherheits-Leitplanken
status: draft
version: 1
---

# Spec: Access-Gate + Sicherheits-Leitplanken (`access-and-guardrails`)

> **Schicht 3 von 3.** Security-kritisch — diese ACs sind das Drift-Gate **und** der Security-Floor in einem.
> Kontext: die Engine ist *pre-granted/unbeaufsichtigt* auf einem **öffentlich erreichbaren** VPS. Cloudflare Access ist die **einzige** Mauer zwischen Internet und einer Claude-Session, die Code pusht und Container baut. Darum sind diese Bedingungen hart und testbar.

## Zweck
Den öffentlichen Endpunkt absichern und die Risiko-Konzentration aus ADR-003 eindämmen: Access-Pflicht, Fail-Fast ohne Konfig, 1-Job-Limit, Kill-Switch, Audit-Log, keine Secret-Leaks.

## Verhalten
1. Eine AccessGuard-Middleware validiert vor **jeder** `/api/*`- und WS-Anfrage den Cloudflare-Access-JWT (`Cf-Access-Jwt-Assertion`) gegen Team-Domain + AUD (Public Keys von `…/cdn-cgi/access/certs`).
2. In Produktion **verweigert der Dienst den Start**, wenn Access-Konfiguration (Team-Domain/AUD) fehlt — niemals ungeschützt online. (Lokal/Dev über explizites Flag umgehbar.)
3. Jeder akzeptierte Command wird append-only protokolliert (Zeit, Access-Identität, Befehl).
4. Der Concurrency-Lock (= 1, siehe [[flow-trigger]]) ist global erzwungen.
5. Keine Secrets gelangen in Frontend-Bundle, Logs, Audit oder WS-Stream.

## Acceptance-Kriterien
- **AC1** — Jede `/api/*`- und WS-Anfrage **ohne** gültigen Access-JWT → `403` (bzw. WS-Abweisung). Gültiger JWT (korrekte Signatur, AUD, Ablauf) → durchgelassen, Identität (E-Mail) extrahiert.
- **AC2** — Startet der Dienst mit `NODE_ENV=production` **ohne** gesetzte Access-Konfig (Team-Domain + AUD), bricht er mit Fehler ab (Exit ≠ 0) und nimmt **keine** Requests an. (Fail-Fast.)
- **AC3** — `GET /api/audit` liefert eine append-only Liste `{time, identity, command}`; jeder über [[flow-trigger]] akzeptierte Command erzeugt **genau einen** Eintrag mit der Access-Identität des Auslösers.
- **AC4** — Der 1-Job-Lock gilt **global** (prozessweit), nicht pro Client/Verbindung: ein zweiter Trigger während eines laufenden Jobs wird abgelehnt (verifiziert über zwei Clients).
- **AC5** — **Keine Secrets** (Anthropic-/API-Keys, GPG-Passphrase, GitHub-/Cloudflare-Tokens) erscheinen im ausgelieferten Frontend-Bundle, in Logs, im Audit oder im WS-Stream. (Floor — über alle Endpunkte geprüft.)

## Verträge
- AccessGuard: validiert `Cf-Access-Jwt-Assertion`; Config = `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (Env). Dev-Bypass nur via explizites `DEV_NO_ACCESS=1` **und** `NODE_ENV!=production`.
- `GET /api/audit` → `200 [{time, identity, command}]`.

## Edge-Cases & Fehlerverhalten
- Abgelaufener/manipulierter JWT → `403`. Fehlender Header → `403`.
- Certs-Endpunkt nicht erreichbar → konservativ `403` (fail-closed), nicht durchlassen.
- Audit-Schreiben schlägt fehl → Command wird **nicht** ausgeführt (kein nicht-auditierter Lauf).

## NFRs
- Fail-closed-Prinzip durchgängig (im Zweifel ablehnen).
- Pre-granted Tool-Permissions der Session sind **dokumentiert** (welche Tools erlaubt sind) — keine impliziten Allmacht-Defaults ohne Notiz.

## Nicht-Ziele
- App-eigener Login/Benutzerverwaltung (Identität kommt von Cloudflare Access, ADR-004).

## Abhängigkeiten
- Schützt [[terminal-bridge]], [[factory-status]], [[flow-trigger]]. Deploy-seitige Access-Policy in [[deployment]].
