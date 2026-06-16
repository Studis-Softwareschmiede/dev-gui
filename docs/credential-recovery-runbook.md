# Credential-Recovery-Runbook

> **Spec:** `docs/specs/credential-runtime-unlock.md` § Boot-Reload + dedizierte Persistenz (v3, AC17)
> **Betroffene ACs:** AC13 (Boot-Reload), AC16 (dediziertes Volume), AC17 (dieses Runbook)

## Überblick

Der `CredentialStore` schützt Credentials at-rest via AES-256-GCM. Der Master-Key
wird einmalig per UI-Unlock eingegeben und auf dem **persistenten Volume `dev-gui-cred`**
(Datei `devgui-cred.env`) gespeichert. Beim nächsten Container-Start liest der Store
diese Datei automatisch (Boot-Reload, AC13) — ohne erneuten UI-Dialog.

---

## Ablauf: Frischer Deploy / VPS-Neuaufbau

### Schritt 1 — Stack hochfahren

```bash
docker compose up -d
```

Nach dem Start ist der `CredentialStore` **gesperrt** (`locked`), weil `devgui-cred.env`
auf dem neuen Volume noch nicht existiert. Das ist erwartet.

- Alle nicht-credential-abhängigen Funktionen (Board, Workspace, SSH-Public-Keys) sind sofort verfügbar.
- Credential-abhängige Operationen (Lesen/Schreiben verschlüsselter Einträge) sind inaktiv, bis entsperrt wird.

### Schritt 2 — Einmalig entsperren über die UI

1. Öffne die dev-gui-Oberfläche im Browser.
2. Navigiere zu **Einstellungen → Credential-Store**.
3. Klicke **Entsperren** und gib den Master-Key ein (aus Bitwarden, Item `dev-gui-master-key`).
4. Der Store entsperrt sich ohne Neustart (`locked → unlocked`).
5. Der Master-Key wird in `/home/node/.cred/devgui-cred.env` auf dem persistenten Volume geschrieben.

### Schritt 3 — Ab sofort automatisch entsperrt

Bei allen zukünftigen Container-Recreates / Reboots liest der `CredentialStore` den
Master-Key beim Boot selbst aus `/home/node/.cred/devgui-cred.env` (Boot-Reload, AC13)
und startet direkt `unlocked` — **kein erneuter UI-Unlock nötig**.

---

## Zu sicherndes Volume / Bind-Mount

| Artefakt | Pfad im Container | Volume / Host |
|---|---|---|
| Master-Key (Persistenz) | `/home/node/.cred/devgui-cred.env` | Named Volume `dev-gui-cred` |
| Encrypted Store | `/home/node/.cred/secrets.enc.json` | Named Volume `dev-gui-cred` |

**VPS-Empfehlung:** Das Named Volume `dev-gui-cred` als Bind-Mount auf einen gesicherten
Host-Pfad konfigurieren (in `docker-compose.yml` unter `services.dev-gui.volumes`):

```yaml
- /opt/dev-gui/state:/home/node/.cred
```

Dies schützt die Credential-State-Dateien vor Docker-Volume-Pruning und ermöglicht
Filesystem-Level-Backups.

---

## Wichtig: `down -v` niemals verwenden

```bash
# FALSCH — zerstört dev-gui-cred-Volume und damit den persistierten Master-Key:
docker compose down -v

# RICHTIG — nur den Container neu erstellen, Volumes bleiben erhalten:
docker compose up -d --force-recreate dev-gui
```

---

## Migration von altem `dev-gui-claude`-Volume (Einmalig)

Falls `devgui-cred.env` und/oder `secrets.enc.json` noch im alten `dev-gui-claude`-Volume
unter `/home/node/.claude/` liegen (Deployments vor S-139):

```bash
# Bestehende Dateien ins neue Volume kopieren (einmalig, vor erstem Recreate):
docker compose exec dev-gui sh -c \
  "cp /home/node/.claude/devgui-cred.env /home/node/.cred/ 2>/dev/null || true; \
   cp /home/node/.claude/dev-gui/secrets.enc.json /home/node/.cred/ 2>/dev/null || true; \
   echo 'Migration done'"

# Danach Stack mit neuer Compose-Version recreaten:
docker compose up -d --force-recreate dev-gui
```

Nach erfolgreicher Migration startet der Store direkt `unlocked` — kein UI-Unlock nötig.

---

## Abgrenzung

Dieses Runbook deckt nur die **lokale Persistenz-Schleife** (Boot-Reload + dediziertes
Volume) ab — Teil A von F-012.

Nicht behandelt hier:
- **Verschlüsseltes Off-Host-Backup/Restore** (`secrets.enc.json` extern sichern) → `credential-backup` (Teil B von F-012, geplant).
- **Master-Key-Beschaffung aus Bitwarden** (automatischer Key-Pull beim Boot) → `bitwarden-master-key-unlock`.
