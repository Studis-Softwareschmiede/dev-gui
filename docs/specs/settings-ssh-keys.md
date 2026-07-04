---
id: settings-ssh-keys
title: SSH-Key-Verwaltung + VPS-Provisionierung
status: draft
area: einstellungen
version: 1
---

# Spec: SSH-Key-Verwaltung + VPS-Provisionierung (`settings-ssh-keys`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
In der SSH-Keys-Sektion der Settings-Ansicht ([[settings-shell]]) lassen sich **SSH-Schlüssel** hinterlegen — typischerweise je VPS-Benutzer (z.B. `root` und `alex`), als Public-Key (für Authorized-Keys) und optional Private-Key (für Verbindungen vom Dienst aus). Der **Public-Key** eines hinterlegten Schlüssels soll **automatisch auf einem VPS provisioniert** werden (Eintrag in `authorized_keys` des Ziel-Benutzers). Diese Spec hat **zwei klar getrennte Capability-Stufen**:
- **Stufe A — Key-Verwaltung (jetzt umsetzbar):** Public/Private-Keys je Benutzer anlegen/ändern/löschen; Private-Key write-only/maskiert wie Credentials.
- **Stufe B — VPS-Provisionierung (Folge-Capability, abgegrenzt):** Public-Key automatisch in `authorized_keys` eines VPS-Ziels eintragen. Hängt am VPS-Provider-/SSH-Boundary, der noch nicht entschieden ist (siehe [[view-vps]] + Offene Architektur-Punkte) — daher eigene AC-Gruppe und eigenes Board-Item.

## Verhalten

### Stufe A — Key-Verwaltung
1. Die SSH-Keys-Sektion listet hinterlegte Schlüssel mit **Benutzer-Label** (z.B. `root`, `alex`), **Public-Key-Status/Anzeige** und **Private-Key-Status** („gesetzt"/„nicht gesetzt", Private-Key niemals im Klartext).
2. Der Nutzer kann je Benutzer-Label einen **Public-Key** hinterlegen/ändern (Public-Keys sind nicht geheim und dürfen vollständig angezeigt werden) und optional einen **Private-Key** setzen (write-only, maskiert, niemals zurückgegeben — wie [[settings-credentials]]).
3. Der Nutzer kann einen hinterlegten Schlüssel (Public und/oder Private) **löschen**.
4. Public-Keys werden **validiert** (erkennbares OpenSSH-Public-Key-Format, z.B. `ssh-ed25519 …` / `ssh-rsa …`); ungültige Eingaben werden abgelehnt, ohne Bestehendes zu verändern.
5. Schreibende/löschende Aktionen werden auditiert (Identität, Benutzer-Label, Aktion, Zeit) **ohne** Private-Key-Klartext.

### Stufe B — VPS-Provisionierung (Folge-Capability)
6. Für ein hinterlegtes Schlüssel-/Benutzer-Paar kann der Nutzer eine **Provisionierung auf ein VPS-Ziel** auslösen: der **Public-Key** wird in `authorized_keys` des Ziel-Benutzers auf dem VPS eingetragen, **idempotent** (kein Duplikat bei wiederholter Ausführung).
7. Die Provisionierung berichtet ein **Ergebnis** (erfolgreich / fehlgeschlagen mit Grund), ohne geheime Werte preiszugeben, und wird auditiert.
8. Die Provisionierung ist eine **mutierende, höher-privilegierte** Aktion (verändert Server-Zugriff) — identitäts-/rollengeschützt und über die bestehende Access-Mauer abgesichert.

## Acceptance-Kriterien

### Stufe A — Key-Verwaltung
- **AC1** — Je Benutzer-Label (z.B. `root`, `alex`) lässt sich ein Public-Key hinterlegen, anzeigen (Public-Key darf vollständig sichtbar sein) und ändern.
- **AC2** — Ein optionaler Private-Key lässt sich setzen/überschreiben; er wird **niemals im Klartext** zurückgegeben (Status „gesetzt"/„nicht gesetzt", maskierte Anzeige), analog [[settings-credentials]].
- **AC3** — Public- und/oder Private-Key lassen sich löschen; danach ist der jeweilige Status „nicht gesetzt".
- **AC4** — Ein eingegebener Public-Key in ungültigem Format wird mit klarer Fehlermeldung (4xx) abgelehnt, ohne einen bestehenden Wert zu verändern.
- **AC5** — Schreibende/löschende SSH-Key-Aktionen werden auditiert (Identität, Benutzer-Label, Aktion, Zeit); der Private-Key-Klartext erscheint nie in Response, Logs, Audit, WS-Stream oder Frontend-Bundle.
- **AC6** — SSH-Key-Endpunkte sind hinter der Access-Mauer; mutierende zusätzlich identitäts-/rollengeschützt (403 ohne Access bzw. ohne Berechtigung).

### Stufe B — VPS-Provisionierung (eigenes Board-Item, depends VPS-Boundary)
- **AC7** — Für ein hinterlegtes Benutzer/Public-Key-Paar lässt sich eine Provisionierung auf ein VPS-Ziel auslösen; bei Erfolg ist der Public-Key in `authorized_keys` des Ziel-Benutzers vorhanden.
- **AC8** — Wiederholte Provisionierung desselben Keys auf dasselbe Ziel ist **idempotent** (kein doppelter `authorized_keys`-Eintrag).
- **AC9** — Die Provisionierung liefert ein klares Ergebnis (Erfolg/Fehler mit Grund) **ohne** Geheim-Leak und schreibt einen Audit-Eintrag; ein Fehlschlag verändert den Server-Zustand nicht teilweise/inkonsistent (best-effort atomar oder klar als fehlgeschlagen gemeldet).
- **AC10** — Die Provisionierungs-Aktion ist nur einer berechtigten Access-Identität zugänglich (403 sonst).

## Verträge
> Pfade/Felder kanonisch; Persistenz + VPS-Boundary sind Architektur-Detail (siehe Offene Punkte).

**Stufe A:**
- **GET `/api/settings/ssh-keys`** → Liste `{ user, publicKey?: string, privateKeyStatus: "set"|"unset", updatedAt? }`. Private-Key-Klartext **nie** enthalten.
- **PUT `/api/settings/ssh-keys/{user}`** — Body `{ publicKey?: string, privateKey?: <klartext> }` → setzt/überschreibt; Response ohne Private-Key-Klartext. Validiert Public-Key-Format.
- **DELETE `/api/settings/ssh-keys/{user}`** (optional Query/Body: nur Public oder nur Private) → entfernt; Response mit aktualisiertem Status.

**Stufe B:**
- **POST `/api/settings/ssh-keys/{user}/provision`** — Body `{ host: string, port?: number, targetUser: string, hostFingerprint?: string }` → trägt Public-Key idempotent in `authorized_keys` des Ziel-Benutzers ein; Response `{ result: "added"|"already-present"|"error", reason? }`. Hinter Access + Identitäts-/Rollencheck (CRED_ADMIN_EMAILS); Audit-First. HTTP-Statuscodes: 200 bei Erfolg, 422 bei fehlendem Key, 502 bei VPS-Fehler (unreachable/auth-failed/host-key-mismatch), 500 bei internem Fehler.

## Edge-Cases & Fehlerverhalten
- Provisionierung ohne hinterlegten Public-Key für den Benutzer → 422, `result:"error"`, `errorClass:"no-public-key"`.
- Provisionierung ohne hinterlegten Private-Key → 422, `result:"error"`, `errorClass:"no-private-key"`.
- VPS-Ziel nicht erreichbar / Auth fehlgeschlagen → 502, `result:"error"` mit Grund, kein Teil-Eintrag, auditiert.
- Bereits vorhandener identischer `authorized_keys`-Eintrag → kein Duplikat (idempotent), `result:"already-present"` (200).
- Host-Key-Fingerprint-Mismatch → 502, `result:"error"`, `errorClass:"host-key-mismatch"`.
- Private-Key-Backend nicht erreichbar/konfiguriert → 500/502 ohne Klartext-Leak; Bestehendes unverändert.

## NFRs
- **Sicherheit (Floor, hart):** Private-Keys at rest verschlüsselt (wie [[settings-credentials]], OA1/OA2 dort), niemals im Frontend-Bundle/Log/Audit/WS-Stream. Public-Keys dürfen im Klartext angezeigt werden.
- **Sicherheit:** Provisionierung ist hoch-privilegiert (öffnet Server-Zugang) → auditiert, identitäts-/rollengeschützt, idempotent, mit explizitem Ergebnis.
- **A11y:** Formularfelder beschriftet, Fehler programmatisch zugeordnet.

## Nicht-Ziele
- Schlüssel-**Erzeugung** auf dem Server (Keygen) — hier nur Hinterlegen vorhandener Keys (kann Folge-Anforderung sein).
- Entfernen von Keys aus `authorized_keys` auf dem VPS (De-Provisionierung) — Folge-Anforderung, falls gewünscht.
- Festlegung des VPS-/SSH-Boundary, des Secret-Speichers und des VPS-Ziel-Schemas (Architektur-Entscheidung, ausstehend).

## Architektur-Punkte (ENTSCHIEDEN — siehe `docs/architecture.md` ADR-007/008)
- **OA1 → ENTSCHIEDEN:** Private-Keys liegen im gemeinsamen `CredentialStore` (ADR-007), Key-Schema `ssh/<user>/private_key` (verschlüsselt) + Public-Key als Klartext-Metadatum. **Kein** separater SSH-Key-Store, **kein** Schreiben ins echte `~/.ssh/` des Containers (Stufe A).
- **OA2 → ENTSCHIEDEN (Boundary, ADR-008, #47 umgesetzt):** Stufe B = **SSH-from-Backend** über `VpsProvisioner`-Boundary (`src/VpsProvisioner.js`) mit `ssh2` Node-Lib (kein Shell-Out). Ziel-Schema `{ host, port?, targetUser }` + optional `hostFingerprint`. Host-Key-Policy: TOFU-accept wenn kein Fingerprint angegeben (Hash im Audit-Eintrag geloggt), strenge Prüfung wenn `hostFingerprint` übergeben. Authorisierung: CRED_ADMIN_EMAILS (identisch ADR-007).
- **OA3 → ENTSCHIEDEN:** wie [[settings-credentials]] — Access-Identität + Pflicht-Audit, optionale `CRED_ADMIN_EMAILS`-Allowlist.

## Abhängigkeiten
- [[settings-shell]] (Sektions-Gerüst + Route).
- [[settings-credentials]] (geteilte write-only-/Masken-/Secret-Store-Mechanik für Private-Keys).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- Stufe B zusätzlich: [[view-vps]] + offener VPS-/SSH-Boundary (Architektur, ausstehend).
</content>
