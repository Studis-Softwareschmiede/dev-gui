---
id: vps-cloud-init-setup
title: VPS Default-Setup-Pipeline via cloud-init / user-data
status: draft
version: 1
---

# Spec: VPS Default-Setup-Pipeline (cloud-init / user-data) (`vps-cloud-init-setup`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate).

## Zweck
Beim **Create-from-scratch** eines neuen Servers ([[vps-provider-boundary]]) läuft automatisch ein **Default-Setup** durch, das der Server beim **ersten Boot selbst** ausführt — übergeben als **cloud-init / user-data** an die Provider-Create-API. Es gibt **kein** SSH-from-Backend für dieses Setup (der Server konfiguriert sich selbst). Das Default-Setup leistet: (1) Ubuntu 26.04 LTS als Basis (das Image wählt der Create-Call), (2) Ubuntu sofort aktualisieren, (3) neueste Docker-Version installieren, (4) zwei Benutzer bereitstellen (`root` und `alex`) mit ihren jeweiligen SSH-Public-Keys ([[vps-ssh-key-assignment]]).

> **Abgrenzung:** Diese Spec definiert **Erzeugung + Inhalt** des cloud-init-Dokuments und die testbaren Garantien des Default-Setups. Der **Image-Slug** und die **Übergabe** der user-data an die jeweilige Provider-API gehören zu [[vps-provider-boundary]]; **welche** Public-Keys injiziert werden, liefert [[vps-ssh-key-assignment]].

## Verhalten
1. Vor jedem Create erzeugt das Backend ein **cloud-init-Dokument** (cloud-config / user-data) aus einer **versionierten Vorlage** + den eingesetzten Parametern (SSH-Public-Keys je User, Hostname/Name).
2. Das Dokument enthält die folgenden Schritte, in dieser Reihenfolge:
   - **(a) System-Update:** Paketquellen aktualisieren und alle Pakete auf den neuesten Stand bringen (Ubuntu-Update direkt beim ersten Boot).
   - **(b) Docker (neueste Version):** Installation der **aktuellsten** stabilen Docker-Engine (offizielle Docker-Apt-Quelle, nicht das veraltete Distro-Paket) inkl. Aktivieren/Starten des Docker-Dienstes.
   - **(c) Benutzer `alex`:** Anlegen (falls nicht vorhanden), mit Login-Shell; Aufnahme in die `sudo`- und `docker`-Gruppe; sein SSH-Public-Key landet in `~alex/.ssh/authorized_keys`.
   - **(d) Benutzer `root`:** sein (distinkter) SSH-Public-Key landet in `/root/.ssh/authorized_keys`.
3. Die SSH-Public-Keys stammen aus [[vps-ssh-key-assignment]] (distinkte Keys je User-Rolle, aus separaten `settings-ssh-keys`-Labels). Es werden **nur Public-Keys** ins cloud-init geschrieben; **niemals** ein Private-Key.
4. Das Default-Setup ist **idempotent/robust** gegenüber cloud-init-Semantik (cloud-init führt user-data einmalig beim ersten Boot aus); die Schritte sind so formuliert, dass ein erneuter Lauf nichts kaputt macht (z.B. User-Anlage „falls nicht vorhanden").
5. Das erzeugte cloud-init-Dokument ist vor der Übergabe an die Provider-API **validierbar** (wohlgeformtes cloud-config-YAML mit `#cloud-config`-Header); ungültige/leere Pflichtparameter (z.B. fehlende Public-Keys für `root` **oder** `alex`) brechen den Create **vor** dem Provider-Call ab.

## Acceptance-Kriterien
- **AC1** — Für einen Create erzeugt das Backend ein wohlgeformtes cloud-config-Dokument (Header `#cloud-config`, gültiges YAML), das genau die vier Default-Setup-Bereiche abdeckt: System-Update, Docker-Installation (neueste stabile Version aus offizieller Docker-Quelle), User `alex`, User `root`.
- **AC2** — Das cloud-config enthält einen Update-Schritt, der die Paketquellen aktualisiert **und** vorhandene Pakete aktualisiert (z.B. `package_update: true` + `package_upgrade: true` bzw. äquivalente runcmd-Schritte) — testbar am erzeugten Dokument.
- **AC3** — Das cloud-config installiert Docker aus der **offiziellen Docker-Apt-Quelle** (neueste stabile Version), **nicht** das ältere Distro-`docker.io`-Paket, und aktiviert/startet den Docker-Dienst. Testbar: das Dokument referenziert die offizielle Docker-Quelle/Installationsschritte, nicht `apt-get install docker.io` als Default.
- **AC4** — Das cloud-config legt Benutzer `alex` mit Login-Shell an, fügt ihn den Gruppen `sudo` **und** `docker` hinzu und schreibt **seinen** Public-Key in `alex`s `authorized_keys`.
- **AC5** — Das cloud-config schreibt den **distinkten** `root`-Public-Key in `/root/.ssh/authorized_keys`; `root`- und `alex`-Key sind getrennt zugeordnet (kein Key-Crossover).
- **AC6** — Das erzeugte Dokument enthält **ausschließlich Public-Keys** und keinerlei Private-Key-Material oder andere Geheimnisse; das Dokument erscheint nicht im Frontend-Bundle als statisches Secret und wird beim Logging (falls geloggt) ohne Geheimnisse behandelt.
- **AC7** — Fehlt für `root` **oder** `alex` ein zugeordneter Public-Key, bricht die Erzeugung mit klarer 422-Meldung ab (`errorClass: "missing-ssh-key"`), **bevor** ein Provider-Create-Call erfolgt — kein Server wird erstellt.
- **AC8** — Die Setup-Vorlage ist **versioniert** (eine identifizierbare Template-Version), sodass spätere Änderungen am Default-Setup nachvollziehbar sind und Tests die Bereiche stabil prüfen können.

## Verträge
> Konkrete cloud-init-Syntax (cloud-config-Keys vs. `runcmd`, exakte Docker-Installations-Schritte) wählt der `coder`; die ACs prüfen die Garantien, nicht die exakte Zeilenform.

- **Eingabe (intern, vom Create-Pfad):** `{ name, sshPublicKeys: { root: string, alex: string } }` (Public-Keys aus [[vps-ssh-key-assignment]]).
- **Ausgabe (intern):** ein cloud-config-String (user-data), den [[vps-provider-boundary]] an die provider-spezifische Create-API übergibt.
- **Default-Image-Bezug:** Ubuntu 26.04 LTS (Image-Slug provider-spezifisch in [[vps-provider-boundary]]); cloud-init geht von einer cloud-init-fähigen Ubuntu-Basis aus.
- **Kein Endpunkt:** diese Capability ist ein interner Erzeuger ohne eigene HTTP-Route; sie wird vom Create-Pfad ([[vps-provider-boundary]]) konsumiert.

## Edge-Cases & Fehlerverhalten
- Public-Key für `root` oder `alex` fehlt → 422 `missing-ssh-key`, kein Create (AC7).
- Public-Key in ungültigem OpenSSH-Format → Ablehnung vor Create (validiert wie [[settings-ssh-keys]] AC4); kein Provider-Call.
- Provider akzeptiert die user-data-Größe nicht (cloud-init zu groß) → Fehler aus dem Create-Pfad mit klarer Meldung; kein Teil-Server.
- Setup-Schritt schlägt **auf dem Server** zur Laufzeit fehl (z.B. Docker-Quelle vorübergehend down) → liegt außerhalb der Backend-Kontrolle; das Backend garantiert nur ein **korrektes** user-data-Dokument, nicht den Server-Laufzeit-Erfolg. (Dokumentiert als Nicht-Ziel der Backend-Verifikation.)

## NFRs
- **Sicherheit (Floor, hart):** Niemals Private-Key-/Geheimnis-Material im cloud-init; nur Public-Keys. cloud-init-Dokument enthält keine Provider-Tokens.
- **Reproduzierbarkeit:** gleiche Eingaben → gleiches (bis auf erlaubte Variablen) Dokument; versionierte Vorlage (AC8).
- **Wartbarkeit:** Default-Setup als **eine** Vorlage zentralisiert, nicht über Provider-Adapter verstreut.

## Nicht-Ziele
- Verifikation des **Laufzeit**-Erfolgs auf dem Server (dass Update/Docker/User tatsächlich durchliefen) — das Backend garantiert nur korrektes user-data.
- Konfigurierbare/abweichende Setup-Profile (genau **ein** Default-Setup in diesem Durchgang).
- Docker-spezifische Hardening-/Compose-Bootstraps über das Default-Setup hinaus.
- SSH-from-Backend-Provisionierung beim Create (bewusst cloud-init; SSH-from-Backend bleibt [[settings-ssh-keys]] Stufe B für laufende Server).

## Abhängigkeiten
- [[vps-provider-boundary]] (Create-Pfad, der die user-data übergibt).
- [[vps-ssh-key-assignment]] (liefert die root-/alex-Public-Keys).
- [[settings-ssh-keys]] (Quelle + Public-Key-Format-Validierung).
