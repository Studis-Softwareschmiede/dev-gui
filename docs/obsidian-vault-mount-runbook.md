# Obsidian-Vault-Mount-Runbook

> **Spec:** `docs/specs/obsidian-vault-config.md` § Container-Erreichbarkeit (Rahmen) + Offene Annahme A1
> (Mount ist dort bewusst als Deploy-Zeit-Entscheidung außerhalb des Spec-Scopes benannt).
> **Owner-Vorfall:** 2026-07-08 — Settings zeigte „Pfad existiert nicht", weil der Vault-Host-Ordner
> nicht in den Container gemountet war (Board S-329).

## Überblick

dev-gui läuft im Container (ADR-006). Ein auf dem **Host** liegender Obsidian-Vault ist im
Container **nur sichtbar, wenn er als Volume gemountet ist** — dieselbe Mount-Grenze wie beim
Workspace ([[workspace-path-config]]). `docker-compose.yml` bringt dafür zwei Bausteine mit:

- **`OBSIDIAN_VAULT_DIR`** (Env, Container-intern, Default `/obsidian-vault`) — die harte
  Containment-Schranke, die `src/obsidianVaultPath.js` (obsidian-vault-config AC3) erzwingt.
- **`OBSIDIAN_VAULT_HOST_DIR`** (Env, Host-Pfad, maschinenabhängig) — die Mount-Quelle. Ohne
  Setzung bleibt „kein Vault konfiguriert" der Normalzustand (kein Boot-Bruch, s. `docker-compose.yml`-
  Kommentar am Volume-Eintrag).

## Wichtig: der Settings-Pfad ist der CONTAINER-Pfad, nicht der Mac-/VPS-Pfad

Der in **Einstellungen → Obsidian-Vault-Pfad** einzugebende Pfad ist der Pfad **aus Sicht des
Backend-Prozesses im Container** — also unterhalb von `/obsidian-vault` (Default `OBSIDIAN_VAULT_DIR`),
**nicht** der Host-Pfad aus `OBSIDIAN_VAULT_HOST_DIR`.

Beispiel (Mac): liegt der Vault auf dem Host unter

```
/Users/alex/Library/Mobile Documents/iCloud~md~obsidian/Documents/AlexSecondBrain
```

und ist `OBSIDIAN_VAULT_HOST_DIR` auf genau diesen Pfad gesetzt, ist der **im Container sichtbare**
und in den Einstellungen einzutragende Pfad einfach:

```
/obsidian-vault
```

(der komplette Host-Ordner wird 1:1 nach `/obsidian-vault` gemountet — kein Unterordner-Rename.)

## Lokal (Mac): Bind-Mount setzen

`docker-compose.override.yml` ist **gitignored** (rein lokale Mac-Datei, kein Commit-Artefakt).
Lokal reicht es, `OBSIDIAN_VAULT_HOST_DIR` in der lokalen `.env` zu setzen:

```
OBSIDIAN_VAULT_HOST_DIR=/Users/alex/Library/Mobile Documents/iCloud~md~obsidian/Documents/AlexSecondBrain
```

Danach `docker compose up -d --force-recreate dev-gui`. In den Einstellungen dann `/obsidian-vault`
als Vault-Pfad setzen (siehe oben — Container-Pfad, nicht der Mac-Pfad).

## VPS

Der Vault liegt auf dem VPS **nicht** am selben Pfad wie auf dem Mac (kein iCloud-Zugriff dort) —
er muss über einen eigenen Sync-Mechanismus (z. B. Syncthing/rsync) auf den VPS repliziert und dessen
resultierender Host-Pfad in `OBSIDIAN_VAULT_HOST_DIR` (VPS-`.env`) eingetragen werden. Der konkrete
Sync-Mechanismus ist **nicht** Teil dieses Runbooks/dieser Story (S-329 liefert nur die Mount-Mechanik);
ohne eine VPS-Seite bleibt der Vault dort schlicht „nicht konfiguriert" — dev-gui degradiert dabei
definiert (obsidian-vault-config AC5: `409 { configured: false }`), kein Crash.

## Zusammenspiel mit S-330

S-330 (Folge-Story) ändert die Unterordner-Konvention innerhalb des gemounteten Vaults
(`src/obsidianVaultPath.js`). Dieses Runbook beschreibt ausschließlich die **Mount-Mechanik**
(diese Story, S-329); die konkrete Pfad-/Unterordner-Konvention innerhalb `/obsidian-vault` ist
Sache von S-330.
