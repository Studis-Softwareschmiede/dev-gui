---
id: red-team-scan-access-token
title: Red-Team-Scan hinter der Access-Wall — Cloudflare-Access-Service-Token (Ausbaustufe 2)
status: active
area: deployment
version: 1
spec_format: use-case-2.0
---

# Spec: Red-Team-Scan hinter der Access-Wall  (`red-team-scan-access-token`)

> **Schicht 3 von 3.** **Ausbaustufe 2** von [[red-team-scan-per-container]]. Erlaubt, die App **hinter**
> der Cloudflare-Access-Wall zu testen (nicht nur die Wand davor), indem der Scan ein
> **Cloudflare-Access-Service-Token** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) als
> Request-Header mitschickt. **Spätere** Story(s) — baut auf dem Engine-/Confinement-Fundament der
> Ausbaustufe 1 auf.

## Zweck

Ausbaustufe 1 testet die App **direkt** (Container-Port) und die **Absperrung** davor (öffentliche URL
gegen die Access-Wall). Ausbaustufe 2 schließt die Lücke „was liegt **hinter** der Wall?": Mit einem
Cloudflare-Access-Service-Token darf der KI-Red-Team-Agent die Access-Wall **legitim** passieren und die
öffentlich exponierte App **selbst** (durch Cloudflare) prüfen.

## Kontext & Grenzen (bindend)

- **Baut auf:** [[red-team-scan-per-container]] AC1–AC6 (Engine, Endpunkte, Confinement) — dieselbe
  `HeadlessScanRunner`-Naht, kein zweiter Runner.
- **Token-Ablage:** Cloudflare-Access-Service-Token wird über den bestehenden verschlüsselten
  `CredentialStore` (ADR-007-Linie) gehalten — **nie** als Freitext/Env. Detail-Ablage-Schema =
  `architekt`/`dba`-Scope (diese Spec legt es nicht fest).
- **ADR-Anteil erforderlich:** neue ausgehende Nutzung eines Cloudflare-Access-Service-Tokens durch den
  Scan-Pfad ist eine neue Trust-Boundary → ADR in `docs/architecture.md`.

## Verhalten

1. Ist für die App ein Cloudflare-Access-Service-Token hinterlegt, kann der Betreiber den öffentlichen
   Testort **„hinter der Wall"** wählen: der Scan schickt `CF-Access-Client-Id` + `CF-Access-Client-Secret`
   als Header an die abgeleitete öffentliche URL und prüft die App **hinter** Access.
2. Ohne hinterlegtes Token bleibt es beim Ausbaustufe-1-Verhalten (nur Wand-Check davor) — die Option ist
   dann sichtbar deaktiviert mit klarer Begründung.

## Acceptance-Kriterien

- **AC1 — Token-Ablage.** Ein Cloudflare-Access-Service-Token (`CF-Access-Client-Id` /
  `CF-Access-Client-Secret`) kann pro App (bzw. global) über den verschlüsselten `CredentialStore`
  hinterlegt/rotiert werden (ADR-007-Linie); **nie** im Klartext persistiert/geloggt.
- **AC2 — Scan hinter der Wall.** Ist ein Token hinterlegt, prüft der öffentliche Testort die App
  **hinter** Access: der Runner reicht die beiden Header an den KI-Red-Team-Auftrag durch (server-seitig,
  argv/Env-diszipliniert), sodass Cloudflare Access den Scan **legitim** passieren lässt.
- **AC3 — Confinement bleibt.** Weiterhin **kein** Freitext-URL-Ziel; das Token wird **ausschließlich** als
  Header zur **abgeleiteten** öffentlichen URL des ausgewählten Containers hinzugefügt.
- **AC4 — Graceful ohne Token.** Ohne hinterlegtes Token ist die „hinter der Wall"-Option deaktiviert
  (klare Begründung); der Ausbaustufe-1-Scan (Wand-Check) läuft unverändert.
- **AC5 — Security-Floor.** Token-Werte erscheinen **nie** in Response/Log/Audit/WS/URL/Argv; nur als
  ausgehende Request-Header. Kein neuer ungeschützter Endpunkt.
- **AC6 — ADR-Anteil.** Die neue Trust-Boundary (Scan passiert die Access-Wall mit Service-Token) ist in
  `docs/architecture.md` als ADR dokumentiert.

## Verträge

- Erweitert die Ausbaustufe-1-Endpunkte um einen optionalen Modus „hinter der Wall" (nur wenn Token
  vorhanden); keine neuen öffentlichen Confinement-Lücken.
- Token-Ablage-Schema im `CredentialStore`: `architekt`/`dba`-Scope (hier nicht festgelegt).

## Edge-Cases & Fehlerverhalten

- **Token ungültig/abgelaufen:** Access weist ab → der Testort meldet klar „hinter Wall: Token abgelehnt"
  statt still zu scheitern.
- **Token vorhanden, App aber ohne Access-Policy:** Verhalten wie Ausbaustufe 1 (Header wirkt neutral).

## NFRs

- **Security:** Service-Token als Secret behandelt (ADR-007-Linie); Defense-in-Depth (kein Klartext, kein
  Leak in Logs/Audit).

## Nicht-Ziele

- **Keine** Cloudflare-Access-Policy-Änderung durch den Scan (nur Passieren mit Token, kein Umkonfigurieren).
- **Kein** zweiter Runner (dieselbe `HeadlessScanRunner`-Naht wie Ausbaustufe 1).

## Abhängigkeiten

- Fundament: [[red-team-scan-per-container]] (Ausbaustufe 1).
- `CredentialStore` (ADR-007), `CloudflareApi`-Umfeld (ADR-010).
