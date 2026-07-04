---
id: ssh-key-rotation
title: Vollautomatische, additive SSH-Key-Rotation auf laufendem VPS (rollback-sicher)
status: draft
area: vps
version: 1
---

# Spec: SSH-Key-Rotation auf laufendem VPS (`ssh-key-rotation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). **Security-kritisch** (verändert Server-Zugang).

## Zweck
Für ein Rollen-Label (`root` | `alex`) den hinterlegten SSH-Key auf einem **laufenden** VPS **vollautomatisch in einem Zug rotieren** — ohne sich auszusperren. Ablauf strikt additiv-dann-aufräumend: neues ed25519-Keypair erzeugen → den **neuen Public-Key additiv** in `authorized_keys` des Ziel-Benutzers einspielen (alter Key bleibt zunächst) → eine **Verbindung mit dem NEUEN Private-Key testen** → **nur bei grünem Test** den **alten Public-Key automatisch entfernen**. Schlägt der Test fehl, bleibt der alte Key erhalten und der Flow bricht klar ab (rollback-sicher, kein Bestätigungs-Halt).

> **Aussperr-Schutz = der Verbindungstest.** Der alte Key wird **niemals** entfernt, bevor mit dem neuen Key erfolgreich eine Verbindung aufgebaut wurde. Damit ist ein Lockout strukturell ausgeschlossen.

## Architektur-Touchpoint (bindend — ADR-008-ERWEITERUNG nötig)
Diese Capability erfordert **zwei neue Fähigkeiten am `VpsProvisioner`-Boundary (ADR-008)**, die der bisherige Provisionierungs-Boundary (#47, nur additives Eintragen) **noch nicht** hat:
1. **Public-Key aus `authorized_keys` entfernen** (gezielt einen bestimmten alten Public-Key des Ziel-Benutzers löschen, idempotent — nicht vorhanden ⇒ no-op).
2. **Verbindungstest mit einem bestimmten Private-Key** (verifizieren, dass ein Login mit dem **neuen** Key gegen `{host, port, targetUser}` gelingt — z.B. eine no-op-Auth/Command-Probe), bevor aufgeräumt wird.

Beides bleibt **innerhalb** des `VpsProvisioner` (einziger SSH-from-Backend-Ort, ADR-008); kein anderer Boundary baut SSH-Verbindungen. Die ADR-008-Skizze deckt bislang nur „Public-Key idempotent eintragen" ab — sie ist um **Remove + connection-test** zu **erweitern** (Architektur-Touchpoint; `architekt` zieht ADR-008 nach: SSH-Lib-Weg `ssh2`, known_hosts/`hostFingerprint`-Strategie wie #47). Der für den Test nötige neue **Private-Key** stammt store-intern aus dem `CredentialStore` (ADR-007) und verlässt das Backend **nie**.

## Verhalten
1. Der Nutzer löst für ein Rollen-Label (`root` | `alex`) und ein VPS-Ziel `{ host, port?, targetUser }` eine **Rotation** aus.
2. Das Backend erzeugt ein **neues ed25519-Keypair** ([[ssh-key-generation]]-Mechanik); der **alte** Private-/Public-Key bleibt zunächst im `CredentialStore` und auf dem Server gültig.
3. Der **neue Public-Key** wird **additiv** in `authorized_keys` des Ziel-Benutzers eingespielt (idempotent, `VpsProvisioner`); der alte Public-Key wird **nicht** angetastet.
4. Das Backend testet eine **Verbindung mit dem neuen Private-Key** gegen das Ziel (`VpsProvisioner`-Verbindungstest).
5. **Bei grünem Test:** der **alte Public-Key** wird automatisch aus `authorized_keys` entfernt (idempotent); der **neue** Key wird zum aktiven Key des Labels im `CredentialStore` (Private + Public ersetzen den alten Eintrag). **Kein** Bestätigungs-Halt — der Flow läuft in einem Zug durch.
6. **Bei rotem Test:** der alte Key bleibt vollständig erhalten (Store **und** Server unverändert bzgl. des alten Keys); der **neue** Public-Key, der in Schritt 3 additiv eingespielt wurde, wird best-effort wieder entfernt (Rollback), und die Rotation bricht mit klarer Fehlermeldung ab. Der Store-Eintrag des Labels bleibt der **alte** Key.
7. Die gesamte Rotation ist **mutierend/hoch-privilegiert**: Access-Mauer + `CRED_ADMIN_EMAILS`-Rollencheck + **Audit-First** (jeder Phasen-Übergang/das Gesamtergebnis ohne Key-Geheimnis).
8. Die Rotation ist **idempotent/wiederholbar**: erneutes additives Einspielen erzeugt kein Duplikat; ein erneuter Lauf nach Teilabbruch führt nicht zu inkonsistentem `authorized_keys`.

## Acceptance-Kriterien
- **AC1** — `POST /api/settings/ssh-keys/{user}/rotate` mit `{ host, port?, targetUser, hostFingerprint? }` führt die Rotation **vollautomatisch in einem Zug** aus (gen → additiv einspielen → Test → bei Erfolg alten Key entfernen), **ohne** zwischenzeitlichen Bestätigungs-Halt.
- **AC2** — Vor dem Verbindungstest ist der **neue** Public-Key **additiv** in `authorized_keys` vorhanden **und** der **alte** Public-Key noch vorhanden (beide gleichzeitig) — testbar am `authorized_keys`-Zustand zwischen Einspielen und Cleanup.
- **AC3** — Der **alte** Public-Key wird **ausschließlich nach grünem Verbindungstest** mit dem **neuen** Key entfernt. Schlägt der Test fehl, bleibt der alte Public-Key in `authorized_keys` erhalten (kein Cleanup) — testbar: bei rotem Test ist der alte Key danach noch vorhanden.
- **AC4** — Bei **erfolgreicher** Rotation ersetzt der neue Key (Private + Public) den alten im `CredentialStore` unter `ssh/<user>/private_key` + Public-Key-Metadatum; danach ist nur noch der neue Public-Key in `authorized_keys`, der alte entfernt. `GET /api/settings/ssh-keys` zeigt den neuen Public-Key.
- **AC5** — Bei **fehlgeschlagenem** Verbindungstest bricht die Rotation mit klarer Fehlermeldung ab (`result: "error"`, `errorClass: "rotation-verify-failed"`, HTTP 502), der **alte** Key bleibt in Store und Server der aktive Key, und der in AC2 additiv eingespielte neue Public-Key wird best-effort zurückgerollt (kein dauerhaft verwaister Fremd-Key).
- **AC6** — Das additive Einspielen **und** das Entfernen des alten Keys sind **idempotent**: wiederholte Rotation/Teil-Wiederholung erzeugt keine doppelten `authorized_keys`-Einträge und keinen inkonsistenten Zustand.
- **AC7** — Die Rotation ist hinter der Access-Mauer und zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik wie ADR-007): 403 ohne Access bzw. ohne Berechtigung. Vor der Ausführung (und bei Ergebnis) wird auditiert (Identität, Rollen-Label, Ziel `host/targetUser`, Aktion `ssh-key-rotate`, Ergebnis) — **ohne** Private-Key-/Geheim-Klartext; schlägt der Audit-Write fehl, unterbleibt die Rotation.
- **AC8** — Über den gesamten Flow verlässt **nie** ein Private-Key (alt oder neu) das Backend Richtung Response/Log/Audit/WS; der für den Test nötige neue Private-Key wird store-intern konsumiert. (Der Export bleibt allein der auditierte Export-Pfad aus [[ssh-key-generation]].)

## Verträge
> Pfade/Felder kanonisch; SSH-Mechanik (ssh2, known_hosts/`hostFingerprint`) = `VpsProvisioner`-Detail (ADR-008-Erweiterung).

- **POST `/api/settings/ssh-keys/{user}/rotate`** — Body `{ host: string, port?: number, targetUser: string, hostFingerprint?: string }` (`{user}` ∈ {`root`, `alex`}) → Response `{ result: "rotated"|"error", oldKeyRemoved?: boolean, newPublicKey?: string, errorClass?: string, reason? }`. Statuscodes: 200 bei Erfolg, 422 bei fehlendem Ausgangs-Key/Ziel, 502 bei VPS-/Verify-Fehler, 500 bei internem Fehler. Hinter Access + `CRED_ADMIN_EMAILS` + Audit-First.
- **`VpsProvisioner`-Erweiterung (intern, ADR-008-Touchpoint):**
  - `addAuthorizedKey({ host, port, targetUser, publicKey, hostFingerprint? })` → idempotentes additives Eintragen (bereits #47).
  - **`removeAuthorizedKey({ host, port, targetUser, publicKey, privateKey, hostFingerprint? })`** → idempotentes Entfernen eines bestimmten Public-Keys (**neu**); `privateKey` für die SSH-Verbindung (üblicherweise der neue, bereits geprüfte Private-Key der Rotation).
  - **`testConnection({ host, port, targetUser, privateKey, hostFingerprint? })`** → `{ ok: boolean, reason? }`; verifiziert Login mit dem gegebenen Private-Key (**neu**).
- **Key-Quelle:** neuer Private-Key store-intern aus `CredentialStore` (ADR-007); Public-Keys als Metadatum. Nur Public-Keys werden Richtung Server geschrieben; Private-Keys nie über HTTP/Log/Audit.

## Edge-Cases & Fehlerverhalten
- Kein bestehender (alter) Key für das Label vorhanden → es gibt nichts zu rotieren: entweder 422 `errorClass: "no-existing-key"` (Rotation setzt einen Ausgangs-Key voraus) **oder** das UI verweist auf [[ssh-key-generation]] (Erst-Generierung). Bindend: kein stilles Anlegen ohne klare Meldung.
- Verbindungstest mit neuem Key schlägt fehl (Netz/Auth/Host-Key) → AC5: alter Key bleibt, neuer additiver Key best-effort entfernt, 502 `rotation-verify-failed`.
- Einspielen des neuen Public-Keys schlägt fehl (VPS unreachable/auth) → Abbruch **vor** dem Test, alter Key unangetastet, 502, kein Store-Wechsel.
- Entfernen des alten Keys schlägt nach grünem Test fehl → der neue Key ist bereits aktiv (Login gesichert); Ergebnis `result: "rotated", oldKeyRemoved: false` + Warnung im `reason` + Audit (kein Lockout, da neuer Key getestet).
- Host-Key-Fingerprint-Mismatch → 502 `errorClass: "host-key-mismatch"` (konsistent mit [[settings-ssh-keys]] Stufe B), keine Key-Änderung.
- Audit-Write schlägt fehl → Rotation unterbleibt vollständig.

## NFRs
- **Sicherheit (Floor, hart):** verändert Server-Zugang → audit-first + `CRED_ADMIN_EMAILS`-rollengeschützt + Access-Mauer; nie Private-Key-Leak (AC8); rollback-sicher (alter Key bleibt bis grüner Test, AC3/AC5).
- **Robustheit:** idempotentes Einspielen/Entfernen (AC6); Teilabbruch hinterlässt keinen Lockout und keinen verwaisten Fremd-Key.
- **Provider-Neutralität:** Rotation ist SSH-from-Backend (provider-unabhängig, ADR-008), unabhängig von der `VpsProviderRegistry` (ADR-009).

## Nicht-Ziele
- Rotation für mehr als die zwei Default-Rollen `root`/`alex`.
- Geplante/automatische Zeit-getriggerte Rotation (in diesem Durchgang nur manuell ausgelöst).
- Rotation auf mehreren Servern in einem Aufruf (ein Ziel je Aufruf; Multi-Server-Fan-out = Folge-Anforderung).
- root-SSH-Härtung (root-Login bleibt unterstützt, Status quo #99/cloud-init — keine Härtung in diesem Durchgang).

## Abhängigkeiten
- [[ssh-key-generation]] (erzeugt den neuen Key; gemeinsame ed25519-Mechanik + Store-Ablage).
- [[settings-ssh-keys]] (Stufe B / `VpsProvisioner` — additives Einspielen #47; hier um Remove + Verbindungstest **erweitert**).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — **ADR-008 (`VpsProvisioner`) ist um Key-Entfernung + Verbindungstest zu ERWEITERN** (Architektur-Touchpoint); ADR-007 (`CredentialStore`, `CRED_ADMIN_EMAILS`).
