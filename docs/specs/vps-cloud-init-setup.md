---
id: vps-cloud-init-setup
title: VPS Default-Setup-Pipeline via cloud-init / user-data
status: draft
version: 4
---

# Spec: VPS Default-Setup-Pipeline (cloud-init / user-data) (`vps-cloud-init-setup`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate).

## Zweck
Beim **Create-from-scratch** eines neuen Servers ([[vps-provider-boundary]]) läuft automatisch ein **Default-Setup** durch, das der Server beim **ersten Boot selbst** ausführt — übergeben als **cloud-init / user-data** an die Provider-Create-API. Es gibt **kein** SSH-from-Backend für dieses Setup (der Server konfiguriert sich selbst). Das Default-Setup leistet: (1) Ubuntu 26.04 LTS als Basis (das Image wählt der Create-Call), (2) Ubuntu sofort aktualisieren, (3) neueste Docker-Version installieren, (4) zwei Benutzer bereitstellen (`root` und `alex`) mit ihren jeweiligen SSH-Public-Keys ([[vps-ssh-key-assignment]]).

> **Abgrenzung:** Diese Spec definiert **Erzeugung + Inhalt** des cloud-init-Dokuments und die testbaren Garantien des Default-Setups. Der **Image-Slug** und die **Übergabe** der user-data an die jeweilige Provider-API gehören zu [[vps-provider-boundary]]; **welche** Public-Keys injiziert werden, liefert [[vps-ssh-key-assignment]].

## Verhalten
1. Vor jedem Create erzeugt das Backend ein **cloud-init-Dokument** (cloud-config / user-data) aus einer **versionierten Vorlage** + den eingesetzten Parametern (SSH-Public-Keys je User, Hostname/Name).
2. Das Dokument enthält die folgenden Schritte:
   - **(a) System-Update:** Paketquellen aktualisieren und alle Pakete auf den neuesten Stand bringen (Ubuntu-Update direkt beim ersten Boot).
   - **(b) Docker (neueste Version):** Installation der **aktuellsten** stabilen Docker-Engine (offizielle Docker-Apt-Quelle, nicht das veraltete Distro-Paket) inkl. Aktivieren/Starten des Docker-Dienstes.
   - **(c) Benutzer `alex`:** über die cloud-init-nativen **`users:`**-Sektion angelegt, mit Login-Shell (`/bin/bash`); Aufnahme in die `sudo`- und `docker`-Gruppe; passwortloses sudo (`NOPASSWD:ALL`); sein SSH-Public-Key wird über `users:`→`ssh_authorized_keys` deployed.
   - **(d) Benutzer `root`:** über die `users:`-Sektion (`disable_root: false`); sein (distinkter) SSH-Public-Key wird über `users:`→`ssh_authorized_keys` deployed.
   - **(e) root-Passwort-Expire entfernen:** ein früher `runcmd`-Schritt (`chage -d -1 root`) hebt das durch das Hetzner-Ubuntu-Image gesetzte Passwort-Ablaufdatum (Epoch 0) auf, damit der root-Key-Login nicht an „Password change required" scheitert.
3. **Deploy-Mechanik (verbindlich, am echten Server verifiziert):** SSH-Public-Keys + Benutzer werden über die cloud-init-native **`users:`**-Sektion bereitgestellt, **nicht** über `write_files`+`runcmd useradd`. Begründung: `write_files` läuft vor `runcmd`, ein `owner: alex:alex` für einen erst in `runcmd` angelegten User bricht das `write_files`-Modul ab (kein Key landet auf dem Server — auch nicht für root). Die `users:`-Sektion legt Benutzer und Keys in korrekter Reihenfolge an, bevor `runcmd` läuft.
4. Die SSH-Public-Keys stammen aus [[vps-ssh-key-assignment]] (distinkte Keys je User-Rolle, aus separaten `settings-ssh-keys`-Labels). Es werden **nur Public-Keys** ins cloud-init geschrieben; **niemals** ein Private-Key.
5. Das Default-Setup ist **idempotent/robust** gegenüber cloud-init-Semantik (cloud-init führt user-data einmalig beim ersten Boot aus); die Schritte sind so formuliert, dass ein erneuter Lauf nichts kaputt macht.
6. Das erzeugte cloud-init-Dokument ist vor der Übergabe an die Provider-API **validierbar** (wohlgeformtes cloud-config-YAML mit `#cloud-config`-Header); ungültige/leere Pflichtparameter (z.B. fehlende Public-Keys für `root` **oder** `alex`) brechen den Create **vor** dem Provider-Call ab.

## Acceptance-Kriterien
- **AC1** — Für einen Create erzeugt das Backend ein wohlgeformtes cloud-config-Dokument (Header `#cloud-config`, gültiges YAML), das genau die vier Default-Setup-Bereiche abdeckt: System-Update, Docker-Installation (neueste stabile Version aus offizieller Docker-Quelle), User `alex`, User `root`.
- **AC2** — Das cloud-config enthält einen Update-Schritt, der die Paketquellen aktualisiert **und** vorhandene Pakete aktualisiert (z.B. `package_update: true` + `package_upgrade: true` bzw. äquivalente runcmd-Schritte) — testbar am erzeugten Dokument.
- **AC3** — Das cloud-config installiert Docker aus der **offiziellen Docker-Apt-Quelle** (neueste stabile Version), **nicht** das ältere Distro-`docker.io`-Paket, und aktiviert/startet den Docker-Dienst. Testbar: das Dokument referenziert die offizielle Docker-Quelle/Installationsschritte, nicht `apt-get install docker.io` als Default.
- **AC4** — Das cloud-config legt Benutzer `alex` über die cloud-init-native **`users:`**-Sektion an (Login-Shell `/bin/bash`), fügt ihn den Gruppen `sudo` **und** `docker` hinzu, gewährt passwortloses sudo (`sudo: "ALL=(ALL) NOPASSWD:ALL"`) und deployt **seinen** Public-Key über `users:`→`ssh_authorized_keys` (nicht über `write_files`).
- **AC5** — Das cloud-config deployt den **distinkten** `root`-Public-Key über die **`users:`**-Sektion (`name: root` + `disable_root: false`); `root`- und `alex`-Key sind getrennt zugeordnet (kein Key-Crossover). Es gibt **keine** `write_files`-Blöcke für `authorized_keys` und **keine** `runcmd useradd`/`usermod`/`mkdir .ssh`-Sequenz mehr für die Key-/User-Anlage.
- **AC6** — Das erzeugte Dokument enthält **ausschließlich Public-Keys** und keinerlei Private-Key-Material oder andere Geheimnisse; Public-Keys landen ausschließlich in `users:`→`ssh_authorized_keys` (cloud-init-nativ, **kein** Shell-Sink in `runcmd`). Das Dokument erscheint nicht im Frontend-Bundle als statisches Secret und wird beim Logging (falls geloggt) ohne Geheimnisse behandelt.
- **AC7** — Fehlt für `root` **oder** `alex` ein zugeordneter Public-Key, bricht die Erzeugung mit klarer 422-Meldung ab (`errorClass: "missing-ssh-key"`), **bevor** ein Provider-Create-Call erfolgt — kein Server wird erstellt.
- **AC8** — Die Setup-Vorlage ist **versioniert** (`TEMPLATE_VERSION`); nach S-170 ist die Version **v5** (v1 → v2: cloud-init-users-Sektion-Fix; v2 → v4: cloudflared-Docker-Container-Block; v4 → v5: cloudflared-Container im Host-Netzwerk `--network host`, AC14). Tests prüfen die Bereiche stabil über die Version.
- **AC9** — *(Live am echten Hetzner-VPS verifiziert.)* Die SSH-Keys werden über die **`users:`**-Sektion deployed, sodass **beide** User (`root` **und** `alex`) nach dem ersten Boot per Key login-fähig sind. Negativ-Garantie testbar am Dokument: der frühere Defekt — `write_files` mit `owner: alex:alex` für einen erst in `runcmd useradd` angelegten User, der das gesamte `write_files`-Modul (inkl. root-Key) abbrechen lässt — ist beseitigt (keine `write_files`-`authorized_keys`-Blöcke mehr).
- **AC10** — *(Live verifiziert.)* Das cloud-config entfernt den durch das Hetzner-Ubuntu-Image gesetzten root-Passwort-Expire (Ablaufdatum Epoch 0) über einen frühen `runcmd`-Schritt **`chage -d -1 root`** (vor/unabhängig vom Docker-Install), damit der root-Key-Login nicht mit „Password change required but no TTY available" scheitert. Testbar: das Dokument enthält den `chage -d -1 root`-Schritt.
- **AC11** — Der bestehende **Docker-CE-Install-Block** (apt-keyrings, `docker.list`, `apt-get install … docker-ce`, `systemctl enable --now docker`) bleibt inhaltlich erhalten und wirksam; `alex` ist weiterhin in den Gruppen `sudo` + `docker` (jetzt über `users:`). AC3/AC4 bleiben damit erfüllt.

### cloudflared (Tunnel-Provisionierung, v3 — siehe [[vps-tunnel-provisioning]])
> Diese ACs gelten **nur**, wenn die cloud-init-Variante für die cloudflared-Provisionierung gewählt wird ([[vps-tunnel-provisioning]] AC5/AC6). Wird stattdessen der post-create-SSH-Pfad gewählt, bleibt TEMPLATE_VERSION bei v2 und diese ACs entfallen; verbindlich ist dann die Mechanik-Garantie aus [[vps-tunnel-provisioning]].

- **AC12** — Wird die cloud-init-Variante gewählt, startet das cloud-config **`cloudflared`** als Docker-Container (Docker ist bereits durch den vorherigen `runcmd`-Block installiert) **im Host-Netzwerk** (`--network host`, siehe AC14): `docker run -d --name cloudflared --restart unless-stopped --network host --env-file /etc/cloudflared/env cloudflare/cloudflared:latest tunnel --no-autoupdate run` — testbar am erzeugten Dokument (cloudflared-docker-run-Schritt in runcmd vorhanden). TEMPLATE_VERSION wird auf **v5** erhöht (v4 = cloudflared-Container ohne `--network host`, korrigiert durch v5). Gewählte Mechanik (coder-Entscheid, S-152): Docker-Container statt systemd-Service — Docker ist ohnehin verfügbar nach dem Docker-CE-Install-Block; kein apt-Repo für cloudflared nötig; einfacher zu pinnen/updaten via Image-Tag.
- **AC13** — Das **Tunnel-Token** wird im cloud-config **secret-sicher** behandelt: es steht ausschließlich als YAML-Wert in einem `write_files`-Block (`/etc/cloudflared/env` als Docker-env-file mit `TUNNEL_TOKEN=<wert>`, permissions `0600`, owner `root:root`) und wird via Docker `--env-file` an den cloudflared-Container übergeben — das Token erscheint **nicht** in einem `runcmd`-Befehl als direktes Argument oder geloggtem Echo ([[vps-tunnel-provisioning]] AC6); cloudflared liest `TUNNEL_TOKEN` nativ aus dem Docker-Env. Das Dokument enthält weiterhin **keine** anderen Geheimnisse (Private-Keys/Provider-Tokens), nur das Tunnel-Token an dieser einen, kontrollierten Stelle. Das cloud-init-Dokument selbst fließt nur an die Provider-Create-API (server-privat). Der `--network host`-Zusatz (AC14) ändert den Token-Floor **nicht**: Token bleibt ausschließlich im `--env-file`, nie in Argv/Log.
- **AC14** — *(Live am echten Hetzner-VPS verifiziert, 2026-06-18.)* Der cloudflared-`docker run`-Eintrag im cloud-config startet den Container im **Host-Netzwerk** (`--network host`), sodass cloudflared das Deploy-Backend über `http://localhost:<hostPort>` erreicht — konsistent mit der Route-Konvention von [[deploy-lifecycle]] (DeployOrchestrator legt Tunnel-Routen auf `http://localhost:<hostPort>` an, wobei `localhost` der **Host** sein muss). Ohne `--network host` läuft cloudflared im Default-Bridge-Netz, in dem `localhost` der cloudflared-Container selbst ist (nicht der Host) → deployte Apps sind über Cloudflare nicht erreichbar (Tunnel healthy, Route + DNS korrekt, Backend `localhost:<port>` aus Container-Sicht unerreichbar). Testbar: das erzeugte cloud-init-YAML enthält im cloudflared-`docker run`-Eintrag das Argument `--network host`; der Token-env-file-Ansatz (`--env-file /etc/cloudflared/env`, AC13) und die restart-Policy (`--restart unless-stopped`) bleiben unverändert kompatibel und erhalten. Regression-Beweis (live): identisches Setup mit Default-Bridge → `https://<app>.<domain>` nicht erreichbar; nach Container-Neustart mit `--network host` → 200.

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
- **Regression (v1, am echten Server reproduziert):** Key-Deploy via `write_files`+`owner: alex:alex` schlägt fehl, weil `alex` erst in `runcmd useradd` (läuft NACH `write_files`) angelegt wird → der alex-Block bricht das gesamte `write_files`-Modul ab, **bevor** der root-Block geschrieben wird → gar kein Key auf dem Server (Login als root UND alex scheitert mit „Permission denied (publickey)"). Fix: `users:`-Sektion statt `write_files` (AC5, AC9).
- **Regression (v1, am echten Server reproduziert):** Hetzner-Ubuntu-Image setzt das root-Passwort-Änderungsdatum auf Epoch 0 → root gilt als „muss Passwort ändern", root-Key-Login scheitert mit „Password change required but no TTY available". Fix: `chage -d -1 root` (AC10).
- **Regression (v4, live am echten VPS reproduziert, 2026-06-18):** cloudflared im Default-Bridge-Netz gestartet → `localhost:<hostPort>` aus Container-Sicht ist der cloudflared-Container selbst, nicht der Host → Tunnel ist healthy, Route + DNS korrekt, aber das App-Backend ist nicht erreichbar (`https://<app>.<domain>` → kein Durchgriff). Beweis: vom Host war `curl localhost:8080` → 200, die Cloudflare-Domain aber unerreichbar; nach manuellem cloudflared-Neustart mit `--network host` (NetworkMode bridge → host) → Domain → 200. Fix: `--network host` im cloudflared-`docker run` (AC14).

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
- [[vps-tunnel-provisioning]] (cloudflared-Abschnitt, AC12/AC13; TEMPLATE_VERSION v3, falls cloud-init-Variante gewählt).
