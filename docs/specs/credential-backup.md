---
id: credential-backup
title: Verschlüsseltes Off-Host-Backup & Restore des Credential-Stores
status: draft
version: 1
---

# Spec: Verschlüsseltes Off-Host-Backup & Restore des Credential-Stores (`credential-backup`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`. Security-kritisch.

## Zweck
Der verschlüsselte Credential-Store (`secrets.enc.json`) wird nach **jedem** erfolgreichen Store-Write automatisch in einem **mit dem Master-Key symmetrisch verschlüsselten GPG-Container** gesichert — zuerst als atomare **lokale Kopie**, danach zusätzlich an ein **Off-Host-Ziel** (S3-kompatibel oder SFTP). Damit überlebt der Credential-State nicht nur Container-Recreate/Volume-Reset (das deckt die lokale Persistenz-Schleife [[credential-runtime-unlock]] Teil A ab), sondern auch **Host-/VPS-Totalverlust**: aus dem Off-Host-Backup **+** dem Master-Key aus Bitwarden ([[bitwarden-master-key-unlock]]) lässt sich der Store vollständig **wiederherstellen**. Diese Spec definiert die **Backup-Engine**, das **Remote-Ziel + dessen Einstellungen**, die **zweistufige UI-Quittung** und den **manuellen Restore-Vorgang** — provider-agnostisch im Verhalten; konkrete Bibliotheken/Clients entscheidet `coder`/`architekt`.

## Grundprinzip Schlüssel (hart)
- Der **Master-Key aus Bitwarden** ist die **einzige** Geheimnisquelle. Es gibt **kein** separates Backup-Keypair.
- `secrets.enc.json` ist bereits AES-256-GCM mit dem Master-Key verschlüsselt (ADR-007). Das Backup ist eine **zusätzlich** GPG-symmetrisch (Passphrase = Master-Key) verschlüsselte Kopie — die zweite Hülle verbirgt zusätzlich Metadaten/Struktur und macht das Off-Host-Artefakt ohne den Master-Key wertlos.
- Wer wiederherstellen will, braucht **Backup-Artefakt + Master-Key** — beide getrennt aufbewahrt (Backup off-host, Key in Bitwarden).

## Verhalten

### Backup-Engine (B-Kern)
1. **Einziger Hook am lock-geschützten Store-Write:** Die Backup-Erzeugung hängt an dem **einen**, durch den Store-Lock geschützten Schreibpfad in `CredentialStore`, über den `secrets.enc.json` geschrieben wird (ADR-007: `CredentialStore` ist der **einzige** Lese-/Schreibpfad). Nach **jedem erfolgreichen** Schreiben auf `secrets.enc.json` wird ein Backup erzeugt. Es gibt **keinen** zweiten Backup-Auslöser und **kein** Cron/Schedule (event-getrieben).
2. **Artefakt-Aufbau:** Das Backup besteht aus dem `secrets.enc.json`-Blob **+** einem **Manifest** (mind. Zeitstempel, Schema-/Backup-Version, optional Store-Größe/Checksumme) — als ein logisches Artefakt. Das gesamte Artefakt wird **GPG-symmetrisch mit dem Master-Key als Passphrase** verschlüsselt.
3. **Lokale Kopie zuerst, atomar:** Das verschlüsselte Artefakt wird **zuerst** als lokale Kopie in ein konfiguriertes Backup-Verzeichnis (im persistenten Credential-Volume, [[credential-runtime-unlock]] §12) geschrieben — **atomar** (tmp + rename) und mit restriktiven Rechten (`0600`).
4. **Backup darf die Cred-Operation nicht zurückrollen:** Schlägt die Backup-Erzeugung fehl, wird die zugrundeliegende Credential-Operation (der erfolgreiche `secrets.enc.json`-Write) **nicht** zurückgerollt — der Store-Write bleibt gültig. Das **Backup-Ergebnis** (Erfolg/Teilerfolg/Fehlschlag, je Stufe) fließt jedoch in die UI-Rückmeldung der Operation ein (siehe Quittung).
5. **Master-Key-Verfügbarkeit:** Backup ist nur im **entsperrten** Zustand möglich (der Master-Key ist die Passphrase). Ist der Store gesperrt, kann kein Store-Write erfolgen → kein Backup-Trigger; ein separater manueller „Jetzt sichern" ist **nicht** Teil dieser Spec.
6. **Retention:** Lokale Kopien unterliegen einer konfigurierbaren Retention (max. Anzahl **und/oder** max. Alter); über die Grenze hinausgehende ältere lokale Artefakte werden aufgeräumt. Retention darf nie das **jüngste** erfolgreiche Backup löschen.

### Off-Host-Ziel (B-Remote)
7. **Zusätzlich zur lokalen Kopie** wird das verschlüsselte Artefakt an ein **Off-Host-Ziel** hochgeladen: Ziel-Typ **S3-kompatibel** oder **SFTP** (Auswahl + Pfad/URL konfigurierbar). Die lokale Kopie bleibt unabhängig vom Remote-Erfolg bestehen.
8. **Remote-Zugangsdaten sind Secrets:** Off-Host-Zugangsdaten (S3 Access-Key/Secret bzw. SFTP-User/Passwort/Key) werden **im `CredentialStore`** abgelegt (write-only, [[settings-credentials]]-Regeln) — **niemals** als Settings-Klartext, **nie** im Frontend-Bundle/Log/Response. Nicht-geheime Teile (Ziel-Typ, Bucket/Host, Pfad-Präfix, Region) dürfen offen konfiguriert sein.
9. **Transport-Robustheit:** Remote-Upload-Fehler (Netz/Auth/Ziel nicht erreichbar) führen **nicht** zum Crash und **nicht** zum Rollback der Cred-Operation. Der Upload wird robust behandelt (begrenzter Retry / klarer Status); ein dauerhaft fehlschlagender Upload wird als **Off-Host-Stufe fehlgeschlagen** quittiert (Warnung statt grüner Quittung), die lokale Kopie bleibt gültig.

### Trigger + zweistufige UI-Quittung
10. **Trigger:** nach **jedem** Store-Write automatisch (kein manueller Button, kein Cron).
11. **Zweistufige Quittung am Schirm:** Die UI zeigt zwei getrennte Stufen: (a) **„lokal gesichert ✓"** sobald die lokale Kopie atomar geschrieben ist; (b) **„off-host gesichert ✓"** nach erfolgreichem Remote-Upload. Bleibt eine Stufe aus oder schlägt fehl, erscheint statt der grünen Quittung eine **Warnung** mit Stufen-genauer Aussage (z.B. „lokal gesichert ✓, off-host fehlgeschlagen ⚠"). Geheimnisfrei — kein Master-Key/Artefakt-Inhalt in der Quittung.

### Backup-Ziel-Einstellungen (UI, B-Remote)
12. **Neuer Abschnitt „Backup / Sicherung"** in der `SettingsView` (`client/src/SettingsView.jsx`): Einstellungen für **Ziel-Typ** (lokal / S3 / SFTP), **Pfad/URL** (Bucket/Host + Pfad-Präfix), **Remote-Creds** (write-only, [[settings-credentials]]-Regeln), **Retention** (Anzahl/Alter), **An/Aus**, sowie eine **Status-Kachel** (letztes Backup: Zeitpunkt, Ergebnis je Stufe, Ziel). Stil-/UX-Vorlage: das bestehende Keygen-/Key-Management-Muster in der `SettingsView` (~Z. 1758–1815). Da es **keine** persistenten App-Settings gibt, leben diese Einstellungen analog zu den heutigen credential-/integrationsbasierten Settings (geheime Teile im `CredentialStore`, nicht-geheime Teile nach Architekt-Entscheid).
13. **Status-Kachel ist leak-frei:** zeigt nur Metadaten (Zeit, Stufen-Ergebnis, Ziel-Typ/-Bezeichnung) — **nie** Master-Key, Remote-Secret oder Artefakt-Inhalt.

### Restore (B-Restore)
14. **Manueller Restore mit Bestätigung:** Eine Restore-UI erlaubt: Backup-Artefakt **hochladen** → **GPG-decrypt** mit dem Master-Key (aus Bitwarden, [[bitwarden-master-key-unlock]]; im laufenden System der bereits geladene Master-Key) → das wiederhergestellte `secrets.enc.json` wird **ans Volume zurückgeschrieben** → der Store ist anschließend entsperrt/nutzbar. Der Restore **überschreibt** den aktuellen Store und erfordert daher eine **explizite Überschreib-Bestätigung**. Er ist bewusst **manuell** (kein Auto-Restore).
15. **Restore-Sicherheit:** Falscher Master-Key / korruptes Artefakt ⇒ GPG-decrypt schlägt fehl ⇒ klarer, klassifizierter, geheimnisfreier Fehler; der **bestehende** `secrets.enc.json` wird dabei **nicht** zerstört (kein Teil-Überschreiben — Schreiben erst nach erfolgreicher Entschlüsselung, atomar tmp+rename). Restore ist eine **hoch-privilegierte** Aktion (Access-Mauer + `CRED_ADMIN_EMAILS`, Audit-First).

## Acceptance-Kriterien

### Engine + lokale Quittung (S-140)
- **AC1** — Nach **jedem** erfolgreichen Schreiben auf `secrets.enc.json` über den lock-geschützten Store-Write-Pfad wird **automatisch** ein Backup-Artefakt erzeugt; es existiert **kein** zweiter Backup-Auslöser und **kein** Cron/Schedule. (Testbar: ein Set/Delete-Credential-Write erzeugt genau ein neues lokales Backup-Artefakt.)
- **AC2** — Das Backup-Artefakt enthält das `secrets.enc.json` **+** ein Manifest (Zeitstempel + Backup-/Schema-Version) und ist **GPG-symmetrisch mit dem Master-Key als Passphrase** verschlüsselt. (Testbar: das Artefakt ist mit dem Master-Key entschlüsselbar und enthält danach Blob + Manifest; **ohne** Master-Key nicht entschlüsselbar.)
- **AC3** — Die lokale Kopie wird **atomar** (tmp + rename) und mit Rechten **`0600`** in das konfigurierte Backup-Verzeichnis im persistenten Credential-Volume geschrieben (kein halb geschriebenes Artefakt bei Crash).
- **AC4** — Schlägt die Backup-Erzeugung fehl, wird der zugrundeliegende erfolgreiche `secrets.enc.json`-Write **nicht** zurückgerollt; die Credential-Operation gilt weiterhin als erfolgreich, das Backup-Ergebnis fließt aber in die UI-Rückmeldung ein (Warnung). (Testbar: bei erzwungenem Backup-Fehler bleibt der gesetzte Credential-Wert gespeichert; die Antwort signalisiert das Backup-Problem.)
- **AC5** — **Retention:** Über die konfigurierte Grenze (Anzahl und/oder Alter) hinausgehende **ältere** lokale Artefakte werden aufgeräumt; das **jüngste** erfolgreiche Backup wird nie gelöscht. (Testbar: bei Limit N und N+1 Backups bleiben genau N, das älteste fällt weg, das neueste bleibt.)
- **AC6** — **lokale Quittung:** Nach erfolgreicher lokaler Kopie liefert die Store-Operation eine Rückmeldung mit Stufe „lokal gesichert ✓"; bei lokalem Fehlschlag eine **Warnung** statt grüner Quittung. (Testbar über die Operations-Response/den UI-State.)
- **AC7** — **Floor:** Master-Key, Master-Passwort und der **entschlüsselte** Store-Klartext erscheinen in **keinem** Log/Audit/HTTP-Response/WS-Frame/Argv/Frontend-Bundle — auch nicht beim Backup-Erzeugen/GPG-Aufruf (GPG-Passphrase nicht über Argv). (Testbar: Logs/Response/Argv enthalten Key/Passwort/Klartext nicht.)

### Off-Host-Backup Backend (S-141)
- **AC8** — **Zusätzlich** zur lokalen Kopie wird dasselbe verschlüsselte Artefakt an das konfigurierte Off-Host-Ziel (S3-kompatibel **oder** SFTP) hochgeladen; die lokale Kopie bleibt unabhängig vom Remote-Ergebnis bestehen.
- **AC9** — **Remote-Creds als Secrets:** Off-Host-Zugangsdaten werden im `CredentialStore` (write-only) gehalten und erscheinen **nie** als Settings-Klartext, **nie** im Frontend-Bundle/Log/Response/WS. (Testbar: Settings-/Status-Antworten enthalten die Remote-Secrets nicht im Klartext.)
- **AC10** — **Transport-Robustheit:** Ein nicht erreichbares/abgelehntes Remote-Ziel führt **nicht** zum Crash und **nicht** zum Rollback der Cred-Operation; der Upload wird robust behandelt (begrenzter Retry/Status) und ein endgültiger Fehlschlag als „off-host fehlgeschlagen ⚠" quittiert, die lokale Kopie bleibt gültig. (Testbar: bei gemocktem Upload-Fehler bleibt der Store-Write erfolgreich + lokale Kopie vorhanden, die Off-Host-Stufe meldet Warnung.)

### Backup-Settings-UI + zweistufige Quittung (S-143)
- **AC11** — **Zweistufige Quittung:** Die UI zeigt „lokal gesichert ✓" sofort nach der lokalen Kopie und „off-host gesichert ✓" nach erfolgreichem Upload; bleibt eine Stufe aus/fehlerhaft, erscheint statt der grünen Quittung eine **Stufen-genaue Warnung**. (Testbar über den UI-State je Stufe.)
- **AC12** — **Settings-Abschnitt „Backup / Sicherung":** Die `SettingsView` bietet einen Abschnitt mit Ziel-Typ (lokal/S3/SFTP), Pfad/URL, Remote-Creds (write-only), Retention, An/Aus und einer **Status-Kachel** (letztes Backup: Zeit, Ergebnis je Stufe, Ziel) — A11y-konform (Labels, Fehlerzuordnung, Touch-Targets ≥ 44 px). Die Status-Kachel zeigt **nur** Metadaten (kein Key/Secret/Klartext). (Testbar: Abschnitt rendert die Felder + Status-Kachel; keine Geheimwerte im DOM/Bundle.)

### Restore (S-142)
- **AC13** — **Restore-Flow:** Über die Restore-UI lässt sich ein Backup-Artefakt hochladen, mit dem Master-Key GPG-entschlüsseln und das wiederhergestellte `secrets.enc.json` ans Volume zurückschreiben; danach ist der Store nutzbar/entsperrt. (Testbar: ein zuvor erzeugtes Artefakt stellt einen Store mit den erwarteten Einträgen wieder her.)
- **AC14** — **Überschreib-Bestätigung:** Der Restore überschreibt den aktuellen Store nur nach **expliziter** Bestätigung; ohne Bestätigung wird **nichts** überschrieben. (Testbar: ohne Bestätigungs-Flag bleibt der bestehende Store unverändert.)
- **AC15** — **Restore-Sicherheit:** Falscher Master-Key / korruptes Artefakt ⇒ klarer, klassifizierter, **geheimnisfreier** Fehler; der bestehende `secrets.enc.json` wird **nicht** zerstört (Schreiben erst nach erfolgreichem Decrypt, atomar tmp+rename). (Testbar: bei falschem Key bleibt der alte Store intakt, Fehler ohne Key/Klartext.)
- **AC16** — **Restore-Schutz + Audit:** Restore ist hinter der Access-Mauer **+** `CRED_ADMIN_EMAILS`-Rollencheck; vor Ausführung wird ein Audit-Eintrag (Identität, Aktion `credential-restore`, Zeit) **ohne** Werte geschrieben (Audit-First). (Testbar: ohne Berechtigung 403; Audit-Eintrag ohne Key/Klartext vorhanden.)

## Verträge
> Pfade/Felder kanonisch im Verhalten; konkrete Clients (S3-SDK/SFTP-Lib/GPG-Aufruf) entscheidet `coder`/`architekt`. `CredentialStore` bleibt der **einzige** Lese-/Schreibpfad zu `secrets.enc.json` (ADR-007).

- **Backup-Engine (intern, am Store-Write-Hook):** nach erfolgreichem `secrets.enc.json`-Write → Artefakt (Blob + Manifest) → GPG-symmetrisch (Passphrase = Master-Key, **nicht** über Argv) → lokale Kopie atomar `0600` → Off-Host-Upload (S3/SFTP) → Stufen-Ergebnis. Liefert ein leak-freies Ergebnisobjekt je Stufe (`local: ok|failed`, `offHost: ok|failed|disabled`) in die Operations-Rückmeldung.
- **Settings (geheim vs. nicht-geheim):** nicht-geheime Backup-Ziel-Konfiguration (Typ, Host/Bucket, Präfix, Region, Retention, An/Aus) — Ablage nach Architekt-Entscheid; **geheime** Remote-Zugangsdaten über die bestehenden Credential-Endpunkte ([[settings-credentials]], write-only). Status-Abfrage liefert nur Metadaten des letzten Backups (Zeit/Stufen-Ergebnis/Ziel) — **kein** Key/Secret/Klartext.
- **Restore (intern + UI):** Upload des Artefakts → GPG-decrypt mit geladenem Master-Key → atomares Zurückschreiben von `secrets.enc.json` → Store-Reload. HTTP-Restore-Endpunkt hinter AccessGuard + `CRED_ADMIN_EMAILS`; Body trägt das Artefakt + Überschreib-Bestätigung; Response geheimnisfrei (nur Erfolg/Status/`errorClass`).
- **Fehlerklassen (geheimnisfrei):** `gpg-decrypt-failed` (falscher Key/korrupt), `restore-write-failed`, `remote-upload-failed`, `backup-failed`, `error`.

## Edge-Cases & Fehlerverhalten
- Store **gesperrt** → kein Store-Write möglich → kein Backup-Trigger (erwartet; kein Fehler).
- GPG nicht verfügbar / Verschlüsselung schlägt fehl ⇒ `backup-failed`, Store-Write bleibt gültig (AC4), Warnung in der Quittung, **kein** Klartext-Artefakt geschrieben.
- Off-Host-Ziel nicht konfiguriert / „aus" ⇒ nur lokale Kopie; Off-Host-Stufe meldet `disabled` (keine Warnung, sondern „nur lokal").
- Remote-Upload partiell/fehlerhaft ⇒ begrenzter Retry, danach `remote-upload-failed` ⇒ „off-host ⚠"; lokale Kopie bleibt.
- Retention-Aufräumen schlägt fehl (z.B. Datei gesperrt) ⇒ nicht-fatal, Backup gilt als erfolgreich; nur Aufräum-Warnung intern, kein Cred-Rollback.
- Restore mit Artefakt aus inkompatibler/zukünftiger Backup-Version (Manifest) ⇒ klarer Versions-Fehler, **kein** Überschreiben.
- Restore mit falschem Master-Key ⇒ `gpg-decrypt-failed`, alter Store unverändert (AC15).
- Doppelter/paralleler Store-Write ⇒ Backups bleiben durch den bestehenden Store-Lock serialisiert (ein Artefakt je Write).

## NFRs
- **Sicherheit (Floor, hart):** Master-Key, Master-Passwort, Remote-Secrets und der entschlüsselte Store-Klartext nie in Log/Audit/Response/WS/Argv/Bundle; GPG-Passphrase nicht über Argv; lokale Artefakte `0600`, atomar; off-host-Artefakt ist ohne Master-Key wertlos (Doppel-Hülle). Restore + Settings-Mutationen auditiert + `CRED_ADMIN_EMAILS`-geschützt.
- **Robustheit:** Backup darf die Cred-Operation nie zurückrollen; Remote-Fehler nie crashen; Restore atomar + nicht-destruktiv bei Fehler.
- **Boundary-Disziplin:** `CredentialStore` bleibt der einzige Lese-/Schreibpfad zu `secrets.enc.json`; der Backup-Hook sitzt an diesem einen Schreibpfad; die GPG-/Off-Host-Mechanik ist eng gekapselt.
- **A11y:** Backup-Settings + Restore-Dialog WCAG 2.1 AA (Labels, Fehlerzuordnung, Fokusführung, Touch-Targets ≥ 44 px, Loading-/Bestätigungs-States).

## Nicht-Ziele (bewusst ausgeschlossen)
- **Separater Backup-Schlüssel / Backup-Keypair** (Defense-in-depth) — der Master-Key aus Bitwarden ist die einzige Geheimnisquelle.
- **Auto-Bootstrap aus Bitwarden beim Boot** (Master-Key beim Start automatisch ziehen) — Erst-Beschaffung bleibt der einmalige UI-Unlock ([[credential-runtime-unlock]] §13).
- **Master-Key als VPS-Klartext-Secret** (z.B. in einer Host-Env/Datei im Klartext) — der Key bleibt in Bitwarden; lokal nur die beim Unlock persistierte `devgui-cred.env`.
- **Automatisiertes Backup-Schedule/Cron** — Backup ist strikt event-getrieben (nach jedem Store-Write).
- **Manueller „Jetzt sichern"-Button** ohne Store-Write — nicht Teil dieser Spec.

## Bedrohungsmodell (dokumentiert)
- **Schützt:** Host-/VPS-Totalverlust + Volume-Reset — aus Off-Host-Artefakt + Master-Key (Bitwarden) ist der Store wiederherstellbar; das Off-Host-Artefakt ist ohne den Master-Key wertlos (zweite GPG-Hülle verbirgt zusätzlich Struktur/Metadaten).
- **Schützt NICHT:** Angreifer mit Root auf dem laufenden Server (kann Master-Key im Prozessspeicher + entschlüsselten Klartext lesen) — bewusst akzeptierter Trade-off (Linie ADR-003/ADR-007).

## Abhängigkeiten
- [[credential-runtime-unlock]] (Master-Key im Prozess + lock-geschützter Store-Write + dediziertes Persistenz-Volume, Teil A von F-012).
- [[bitwarden-master-key-unlock]] (Master-Key als alleinige Geheimnisquelle / Wiederbeschaffung beim Restore nach Totalverlust).
- [[settings-credentials]] / ADR-007 (`CredentialStore` als einziger `secrets.enc.json`-Pfad; write-only Remote-Creds).
- [[access-and-guardrails]] (Access-Mauer + Audit + `CRED_ADMIN_EMAILS` für Restore/Settings-Mutationen; Floor „keine Secret-Leaks").
- [[settings-shell]] (Sektions-Gerüst der Einstellungsseite für „Backup / Sicherung").
</content>
