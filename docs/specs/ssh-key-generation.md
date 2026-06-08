---
id: ssh-key-generation
title: SSH-Keypair-Generierung im Panel (root/alex) + auditierter Private-Key-Export
status: draft
version: 1
---

# Spec: SSH-Keypair-Generierung im Panel (`ssh-key-generation`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). **Security-kritisch** (Private-Key-Material, bewusster ADR-007-Tradeoff).

## Zweck
Der Nutzer kann direkt in der SSH-Keys-Sektion der Settings-Ansicht ([[settings-shell]]) für eine **Rollen-Label** (`root` oder `alex`) ein neues **ed25519**-Keypair **erzeugen lassen** — ohne das Keypair vorher anderswo herzustellen. Der **Private-Key** wird verschlüsselt im `CredentialStore` (ADR-007) abgelegt (Basis für Backend-Provisionierung [[settings-ssh-keys]] Stufe B und Rotation [[ssh-key-rotation]]); der **Public-Key** wird als Klartext-Metadatum unter demselben Rollen-Label hinterlegt und ist damit sofort für die VPS-Create-Zuordnung ([[vps-ssh-key-assignment]]) und cloud-init ([[vps-cloud-init-setup]]) nutzbar. Der generierte Private-Key kann zusätzlich über eine **privilegierte, auditierte Export-Aktion DAUERHAFT erneut** heruntergeladen werden.

> **Strategie A (OpenSSH-Standard):** Der nutzer-zentrale Ort für Keys bleibt `~/.ssh/` + ssh-agent/Keychain. dev-gui erzeugt hier **zusätzliche** Keypaare, deren Public-Key per cloud-init injiziert wird und deren Private-Key dev-gui für Backend-Provisionierung/Rotation hält. Die Generierung erzeugt **immer ed25519** (kein RSA-Default).

## Sicherheits-Tradeoff (bewusst, dauerhaft) — bindend
ADR-007 fordert für den `CredentialStore` ein **write-only**-Prinzip: Geheimnis-Klartext verlässt den Store **nie** Richtung HTTP/Log/Audit/WS. Diese Spec **durchbricht das BEWUSST und DAUERHAFT für VPS-SSH-Private-Keys**: der erzeugte Private-Key ist **jederzeit erneut exportierbar** (nicht nur einmalig nach Generierung). Begründung: privates Werkzeug für 1–2 vorab durch Cloudflare Access freigeschaltete Identitäten (ADR-003-pre-granted-Linie); der Betreiber braucht denselben Key im eigenen `~/.ssh/`/Keychain und muss ihn ggf. erneut auf weitere Geräte ziehen. Der Tradeoff wird **eng eingehegt**:
- Export ist **die einzige** Ausnahme: Private-Key-Klartext erscheint **ausschließlich** in der HTTP-Response der expliziten Export-Aktion — **nie** in normalen Lese-Antworten (`GET /api/settings/ssh-keys`), **nie** in Logs, Audit, WS-Stream oder Frontend-Bundle.
- Export (und Generierung) sind **hoch-privilegiert**: hinter der Access-Mauer **und** zusätzlich identitäts-/rollengeschützt mit derselben `CRED_ADMIN_EMAILS`-Logik wie ADR-007 (gesetzt → nur Allowlist; leer → jede gültige Access-Identität).
- **Audit-First bei jedem Export**: vor der Auslieferung des Private-Keys wird ein Audit-Eintrag geschrieben (Identität, Rollen-Label, Aktion `ssh-key-export`, Zeit) — **ohne** Key-Klartext; schlägt der Audit-Write fehl, unterbleibt der Export.

## Verhalten
1. In der SSH-Keys-Sektion kann der Nutzer je Rollen-Label (`root` | `alex`) eine **Generierung** auslösen. Das Backend erzeugt ein neues **ed25519**-Keypair (OpenSSH-Format).
2. Der **Private-Key** wird verschlüsselt im `CredentialStore` unter `ssh/<user>/private_key` abgelegt (ADR-007-Schema, AES-256-GCM); der **Public-Key** wird als Klartext-Metadatum desselben Rollen-Labels hinterlegt (Public-Key-Block, nicht verschlüsselt — ADR-007).
3. Eine Generierung für ein Label, das bereits einen Key trägt, **überschreibt** den bestehenden Key nur nach expliziter Bestätigung im UI (Schutz vor versehentlichem Verlust eines noch auf Servern aktiven Keys); ohne Bestätigung bleibt der bestehende Key unverändert.
4. Nach erfolgreicher Generierung zeigt das UI den **Public-Key** vollständig an (kopierbar) und bietet den **Private-Key-Export** an; der Private-Key-Klartext wird in der Generierungs-Antwort **nicht automatisch** mitgeliefert, sondern nur über die separate, auditierte Export-Aktion.
5. Der **Private-Key-Export** ist **dauerhaft** verfügbar: solange ein Private-Key für das Label gesetzt ist, kann er über die explizite Export-Aktion **jederzeit erneut** heruntergeladen werden (nicht one-shot). Jeder Export wird einzeln auditiert.
6. Generierung und Export sind **mutierende/privilegierte** Aktionen: Access-Mauer + `CRED_ADMIN_EMAILS`-Rollencheck + Audit-First.
7. Der so erzeugte Public-Key steht sofort als wählbares `settings-ssh-keys`-Label (mit gesetztem Public-Key) für die VPS-Create-Zuordnung ([[vps-ssh-key-assignment]] AC1) und damit cloud-init zur Verfügung.

## Acceptance-Kriterien
- **AC1** — Für ein Rollen-Label (`root` | `alex`) lässt sich ein neues **ed25519**-Keypair erzeugen (`POST /api/settings/ssh-keys/{user}/generate`). Erfolg → Private-Key liegt verschlüsselt im `CredentialStore` (`ssh/<user>/private_key`), Public-Key als Klartext-Metadatum; `GET /api/settings/ssh-keys` zeigt das Label danach mit gesetztem Public-Key und `privateKeyStatus: "set"`.
- **AC2** — Der erzeugte Schlüssel ist nachweislich **ed25519** im OpenSSH-Format (Public-Key beginnt mit `ssh-ed25519 `); kein RSA/anderer Default.
- **AC3** — Die Generierungs-Antwort enthält den **Public-Key** (darf vollständig sichtbar sein), **niemals** den Private-Key-Klartext. Der Private-Key erscheint nicht in der Generierungs-Response, in Logs, Audit, WS-Stream oder Frontend-Bundle.
- **AC4** — Der Private-Key lässt sich über eine **separate, explizite Export-Aktion** (`GET /api/settings/ssh-keys/{user}/private-key/export`) abrufen und **DAUERHAFT erneut** (mehrfach, nicht one-shot) — solange ein Private-Key gesetzt ist. Die Export-Response liefert den OpenSSH-Private-Key-Klartext; dies ist der **einzige** Pfad, über den Private-Key-Klartext das Backend verlässt.
- **AC5** — Jeder Export schreibt **vor** Auslieferung einen Audit-Eintrag (Identität, Rollen-Label, Aktion `ssh-key-export`, Zeit) **ohne** Key-Klartext; schlägt der Audit-Write fehl, unterbleibt der Export (keine nicht-auditierte Key-Preisgabe). Ebenso wird die Generierung auditiert (`ssh-key-generate`).
- **AC6** — Generierung **und** Export sind hinter der Access-Mauer und zusätzlich identitäts-/rollengeschützt (`CRED_ADMIN_EMAILS`-Logik wie ADR-007): ohne gültigen Access → 403; gesetzte Allowlist und nicht-berechtigte Identität → 403. Normale Lese-Antworten (`GET /api/settings/ssh-keys`) liefern **nie** den Private-Key.
- **AC7** — Eine Generierung auf ein bereits belegtes Label überschreibt den vorhandenen Key **nur** mit explizitem Overwrite-Flag/Bestätigung; ohne diese bleibt der bestehende Key unverändert (4xx mit klarer Meldung, kein stiller Verlust).
- **AC8** — Der erzeugte Public-Key ist unmittelbar als Label mit gesetztem Public-Key für [[vps-ssh-key-assignment]] (Create-Zuordnung) wählbar und für [[vps-cloud-init-setup]] auflösbar (kein Zwischenschritt nötig).

## Verträge
> Pfade/Felder kanonisch; Persistenz = `CredentialStore` (ADR-007). Schlüssel-Algorithmus = ed25519 (fix).

- **POST `/api/settings/ssh-keys/{user}/generate`** — Body optional `{ overwrite?: boolean, comment?: string }` (`{user}` ∈ {`root`, `alex`}) → erzeugt ed25519-Keypair, legt Private-Key verschlüsselt (`ssh/<user>/private_key`) + Public-Key als Metadatum ab. Response `{ user, publicKey: string, privateKeyStatus: "set", generatedAt: <iso> }` — **kein** Private-Key-Klartext. Hinter Access + `CRED_ADMIN_EMAILS` + Audit-First (`ssh-key-generate`).
- **GET `/api/settings/ssh-keys/{user}/private-key/export`** → Response liefert den Private-Key-Klartext (OpenSSH-PEM/`-----BEGIN OPENSSH PRIVATE KEY-----`), z.B. als `text/plain`/Download-Attachment. **DAUERHAFT** wiederholbar. Hinter Access + `CRED_ADMIN_EMAILS` + Audit-First (`ssh-key-export`). Kein gesetzter Private-Key → 404 `errorClass: "no-private-key"`.
- **Bestehend (unverändert, [[settings-ssh-keys]]):** `GET /api/settings/ssh-keys` liefert weiterhin **nie** Private-Key-Klartext (`privateKeyStatus` only).

## Edge-Cases & Fehlerverhalten
- Generierung auf belegtes Label ohne `overwrite` → 409/4xx `errorClass: "key-exists"`, Bestehendes unverändert.
- Export ohne gesetzten Private-Key (Label nie generiert oder Private-Key gelöscht) → 404 `errorClass: "no-private-key"`, kein Leak.
- Unbekanntes/ungültiges `{user}` (nicht `root`/`alex`) → 404/422.
- `CredentialStore` nicht erreichbar/inkonsistent (GCM-Tag-Fehler) → 5xx **ohne** Key-Klartext-Leak; Bestehendes unverändert.
- Audit-Write schlägt fehl (Generierung oder Export) → Aktion unterbleibt, kein Key persistiert/ausgeliefert.
- Master-Key fehlt in Produktion (`CRED_MASTER_KEY`) → Generierung schlägt fehl (kein unverschlüsseltes Ablegen); Boot-Fail-Fast greift bereits (ADR-007).

## NFRs
- **Sicherheit (Floor, hart):** Private-Keys at rest AES-256-GCM (ADR-007); Private-Key-Klartext **ausschließlich** in der Export-Response, nie sonst (Response normaler GETs/Logs/Audit/WS/Frontend-Bundle). Export + Generierung audit-first + rollengeschützt.
- **Sicherheit (dokumentierter Tradeoff):** Der dauerhaft wiederholbare Export ist ein **bewusster, dauerhafter** Bruch des ADR-007-write-only-Prinzips, eng eingehegt durch Access + `CRED_ADMIN_EMAILS` + Audit-First (s. Abschnitt „Sicherheits-Tradeoff").
- **A11y:** Generierungs-/Export-Aktionen beschriftet; Overwrite-Bestätigung programmatisch zugeordnet; Public-Key kopierbar mit Label.

## Nicht-Ziele
- RSA- oder andere Key-Typen (genau ed25519 in diesem Durchgang).
- Automatisches Einspielen des erzeugten Keys auf laufende Server (das ist [[settings-ssh-keys]] Stufe B / [[ssh-key-rotation]]).
- Mehr als die zwei Default-Rollen `root`/`alex`.
- Passphrase-geschützte Private-Keys (in diesem Durchgang unverschlüsselt im OpenSSH-Format im Store — Schutz liegt im `CredentialStore`-At-Rest + Export-Guardrails).

## Abhängigkeiten
- [[settings-ssh-keys]] (Stufe-A-Key-Verwaltung, Listen-/Status-Endpunkte, Format, CredentialStore-Ablage; diese Spec ergänzt Generierung + Export).
- [[vps-ssh-key-assignment]] (#99 — konsumiert den erzeugten Public-Key als wählbares Label).
- [[vps-cloud-init-setup]] (Public-Key landet via Create in authorized_keys).
- [[ssh-key-rotation]] (nutzt den im Store gehaltenen Private-Key als Basis).
- [[access-and-guardrails]] (Access-Mauer + Audit + Identität).
- `docs/architecture.md` — ADR-007 (`CredentialStore`, Schema, `CRED_ADMIN_EMAILS`).
