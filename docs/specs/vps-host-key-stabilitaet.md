# VPS-Host-Key-Stabilität über Rebuilds (SSH-Terminal ohne manuellen `ssh-keygen -R`)

Status: Implementiert (Variante a) · **Live-Verifikation gegen echtes cloud-init ausstehend
(Owner)** — siehe Abschnitt „Live-Verifikation" unten · Feature: [[F-052]] (VPS-SSH-Terminal) ·
zugehörige Story: S-425

## Problem

Das dev-gui-SSH-Terminal (F-052) verbindet sich per SSH mit strenger Host-Key-Prüfung
gegen `~/.cred/ssh_known_hosts` (im dev-gui-Container). Wird ein VPS **neu aufgesetzt**
(Rebuild, Neuinstallation, IP-Wiederverwendung), generiert der Server **neue**
SSH-Host-Keys. Der gespeicherte Key passt dann nicht mehr → SSH lehnt die Verbindung
mit `host-key-mismatch` ab („möglicher MITM — Verbindung abgelehnt").

Aktueller Workaround (manuell, jeder Rebuild erneut): den veralteten Eintrag von Hand
entfernen —
```
ssh-keygen -f /home/node/.cred/ssh_known_hosts -R <vps-ip>
```
— und beim nächsten Connect den neuen Fingerprint blind akzeptieren.

**Vorfall 2026-07-22:** Nach einem VPS-Rebuild schlug das SSH-Terminal für
`46.62.200.167` mit `host-key-mismatch` fehl; der Eintrag musste manuell aus der
`known_hosts` des dev-gui-Containers entfernt werden, bevor die Verbindung wieder ging.

## Ziel

Bei einem **legitimen** Rebuild soll **kein manueller Eingriff** mehr nötig sein — **ohne**
den MITM-Schutz für **unerwartete** Host-Key-Wechsel aufzugeben.

## Lösungswege (Entscheidung Teil der Story, AC4)

**Variante (a) — bevorzugt: Host-Key persistieren.**
Beim VPS-Bootstrap die `/etc/ssh/ssh_host_*`-Keys aus einem gesicherten Bestand
wiederherstellen (statt neu generieren zu lassen). Der Fingerprint bleibt über Rebuilds
**stabil** → gar kein Mismatch, das Pinning bleibt echt und aussagekräftig.

**Variante (b) — Alternative: known_hosts gezielt bereinigen.**
dev-gui entfernt den veralteten `known_hosts`-Eintrag **automatisch**, wenn es selbst
einen Rebuild/Neu-Deploy dieses bekannten Ziels ausgelöst hat (nur dann). Bequemer,
schwächt aber den Schutz: ein *unerwarteter* Wechsel außerhalb eines dev-gui-Rebuilds
muss weiterhin abgelehnt werden.

## Entscheidung (AC4): Variante (a) implementiert

**Was "dev-gui ausgelöster VPS-Rebuild" konkret bedeutet (Präzisierung):** dev-gui bietet
keine native "Server neu aufsetzen, IP/ID behalten"-Aktion beim Provider — die einzige
Lebenszyklus-Operation, die einen VPS für ein bestehendes Ziel neu bootet, ist
`VpsProviderRegistry.delete()` gefolgt von `VpsProviderRegistry.create()` mit demselben
Ziel-Namen (Provider-`serverId`/IP dürfen dabei wechseln). Das ist der Rebuild-Begriff,
den AC1–AC4 dieser Story abdecken. **Abgrenzung:** die separat vertagte, native
In-Place-„Rebuild"-Provider-Aktion ([[vps-rebuild-backup]], bewusst nicht in diesem
Durchgang implementiert) bleibt unberührt — diese Story implementiert **keinen** Teil
davon; sollte jene Aktion später umgesetzt werden, müsste sie denselben
`#provisionHostKeyForTarget`-Mechanismus mit anspeisen, um AC1 auch für diesen Pfad zu
erfüllen (Folge-Item, nicht Teil von S-425).

**Umsetzung (Variante a):** `VpsProviderRegistry` erzeugt beim ersten `create()` für einen
Ziel-Namen einmalig ein Ed25519-SSH-Host-Keypaar (dieselbe Erzeugung wie bei SSH-User-Keys,
`sshKeysRouter.generateEd25519Keypair`) und persistiert es verschlüsselt im CredentialStore
(`credentials/misc/vps-<name>-host-key`) — **unabhängig** vom Server-Delete/-Create-Zyklus,
also **nicht** Teil des Ziel-Datensatzes und **nicht** Teil des Tunnel-Cleanups. Jeder
nachfolgende `create()` für denselben Namen liest den bereits persistierten Host-Key statt
einen neuen zu erzeugen und übergibt ihn an `CloudInitBuilder.build({ sshHostKey })`, die ihn
über das cloud-init-native `ssh_keys:`-Directive (`ed25519_private`/`ed25519_public`) an den
Server weiterreicht. cloud-init (`cc_ssh`) generiert für einen Key-Typ nur dann selbst einen
neuen Host-Key, wenn `ssh_keys.<typ>_private` **nicht** gesetzt ist — mit gesetztem Wert
bootet der Server mit **genau diesem** Schlüsselpaar. Der im dev-gui-Container bereits
gepinnte `known_hosts`-Eintrag (`SshPtyManager`, `~/.cred/ssh_known_hosts`) passt danach
weiterhin exakt → kein `host-key-mismatch`, kein manueller Eingriff (AC1/AC3).

**Warum (a) statt (b):**
- (a) macht den Mismatch strukturell unmöglich, statt ihn nachträglich zu kaschieren —
  kein Fenster, in dem ein veralteter known_hosts-Eintrag erst erkannt und dann entfernt
  werden müsste (Variante b hätte genau dieses Zeitfenster + eine explizite "war das ein
  dev-gui-Rebuild?"-Kopplungslogik gebraucht).
- (a) benötigt keinen client- oder serverseitigen Zustand darüber, "wann zuletzt ein
  Rebuild lief" — der Host-Key selbst ist die Kopplung (er wird nur bei einem `create()`
  desselben Ziel-Namens durch `VpsProviderRegistry` wiederverwendet).
- AC2 (MITM-Schutz für unerwartete Wechsel) bleibt automatisch erhalten, **ohne** eine
  eigene Erkennungslogik für "war das ein bekannter Rebuild": ein Host, der nicht mit dem
  persistierten Schlüsselpaar gebootet wurde (manueller Fremd-Rebuild außerhalb von
  dev-gui, echter MITM), liefert einen abweichenden Live-Host-Key → `SshPtyManager`s
  unveränderte `StrictHostKeyChecking=accept-new`-Policy lehnt wie bisher ab.
- `cloud-init`s `ssh_keys:`-Directive ist ein natives, dafür vorgesehenes Feature (keine
  Eigenbau-Logik über `write_files`/`runcmd`, Simplicity-Leiter Stufe 4) — dieselbe
  Vertraulichkeits-Klasse wie der bereits etablierte Tunnel-Token-Mechanismus (S-152 AC13).

## Acceptance Criteria

- **AC1** — Nach einem durch dev-gui ausgelösten VPS-Rebuild verbindet sich das
  SSH-Terminal **ohne** manuelles `ssh-keygen -R` und **ohne** host-key-mismatch-Abbruch.
- **AC2** — Ein Host-Key-Wechsel, der **nicht** durch einen bekannten Rebuild erklärt ist,
  führt **weiterhin** zur Ablehnung (MITM-Schutz bleibt für unerwartete Wechsel erhalten).
- **AC3** — Der Nutzer muss bei legitimem Rebuild keinen manuellen known_hosts-Eingriff
  mehr vornehmen.
- **AC4** — Die gewählte Variante (a vs. b) ist mit Begründung dokumentiert; bei (b) ist
  die Bereinigung strikt an einen dev-gui-eigenen Rebuild dieses Ziels gekoppelt.

## Nicht-Ziele

- Kein generelles Deaktivieren der Host-Key-Prüfung (`StrictHostKeyChecking no` o.ä.) —
  das würde den MITM-Schutz vollständig aufheben und ist ausdrücklich ausgeschlossen.

## Live-Verifikation (ausstehend — Owner)

**Warum ausstehend:** Alle bisherigen Tests (`CloudInitBuilder.test.js`,
`VpsProviderRegistry.test.js`, `vpsRegistryDelete.test.js`) sind String-/Struktur-Assertions
gegen den von `CloudInitBuilder` erzeugten YAML-Text bzw. gegen den `VpsProviderRegistry`-
internen Ablauf (welcher Wert an `build()` übergeben wird, ob derselbe Host-Key beim zweiten
`create()` wiederverwendet wird). Kein Test beweist, dass das reale `cloud-init` (`cc_ssh`) auf
den tatsächlich verwendeten Provider-Images das `ssh_keys.ed25519_private`/`_public`-Directive
so behandelt wie hier angenommen (Server bootet mit GENAU diesem Schlüsselpaar statt einem neu
generierten). Ein realer Server-`delete()`+`create()`-Zyklus ist eine destruktive, kostenpflichtige
externe Aktion gegen ein reales (möglicherweise produktives) Ziel — das wurde in den bisherigen
headless-Durchläufen bewusst NICHT automatisiert ausgeführt und bleibt ein manueller
Owner-Schritt.

**Vorgehen (manuell, durch den Owner):**

1. Ein VPS-Ziel wählen, das für einen Test-Rebuild verfügbar ist (idealerweise ein bereits
   angelegtes Test-/Wegwerf-Ziel, NICHT ein produktiv genutztes Ziel — Rebuild ist destruktiv).
2. Vor dem Rebuild: über das dev-gui-SSH-Terminal einmal erfolgreich verbinden und den aktuell
   gepinnten Host-Key-Fingerprint notieren (z. B. via `ssh-keygen -F <ip>` im Container oder den
   Eintrag in `~/.cred/ssh_known_hosts` ansehen).
3. Über die dev-gui-VPS-Verwaltung **`delete()`** für dieses Ziel auslösen, danach **`create()`**
   mit **demselben Ziel-Namen** erneut aufrufen (das ist der in dieser Spec definierte
   „dev-gui ausgelöste Rebuild", siehe Abschnitt „Entscheidung (AC4)" oben — Provider-`serverId`/
   IP dürfen dabei wechseln).
4. Sobald der neue Server bereit ist: über das dev-gui-SSH-Terminal verbinden.
   - **Erwartetes Ergebnis (AC1/AC3):** Die Verbindung gelingt **ohne** manuellen
     `ssh-keygen -R`-Eingriff und **ohne** `host-key-mismatch`-Abbruch — der Fingerprint ist
     identisch zum in Schritt 2 notierten.
5. **Negativ-Erwartung (AC2):** Zum Nachweis, dass der MITM-Schutz für *unerwartete* Wechsel
   erhalten bleibt, denselben Server-Namen einmal **außerhalb** von dev-gui neu aufsetzen (z. B.
   Neuinstallation direkt über die Provider-Konsole, nicht über dev-gui `delete()`+`create()`) —
   oder ersatzweise den persistierten Host-Key-Datensatz im CredentialStore
   (`credentials/misc/vps-<name>-host-key`) manuell entfernen und dann neu aufsetzen. In diesem
   Fall **muss** das SSH-Terminal wie bisher mit `host-key-mismatch` ablehnen (kein Bypass).
6. Ergebnis (Erfolg/Fehlschlag je Schritt) hier oder im zugehörigen Board-Item nachtragen und
   den Status-Header oben aktualisieren (`Live-Verifikation` → `bestätigt am <Datum>` bzw.
   `fehlgeschlagen — siehe Notiz`).

**Nach erfolgreicher Live-Verifikation:** Status-Zeile oben auf „Implementiert (Variante a) ·
Live-verifiziert am `<Datum>`" aktualisieren — dieser Abschnitt kann dann als abgeschlossen
markiert (nicht gelöscht) werden, damit die Nachvollziehbarkeit erhalten bleibt.
