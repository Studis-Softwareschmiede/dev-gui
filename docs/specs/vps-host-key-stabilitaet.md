# VPS-Host-Key-Stabilität über Rebuilds (SSH-Terminal ohne manuellen `ssh-keygen -R`)

Status: To Do · Feature: [[F-052]] (VPS-SSH-Terminal) · zugehörige Story: S-420

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
