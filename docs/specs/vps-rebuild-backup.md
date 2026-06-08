---
id: vps-rebuild-backup
title: VPS Rebuild + Backup (Platzhalter / Folge-Capability)
status: draft
version: 1
---

# Spec: VPS Rebuild + Backup (`vps-rebuild-backup`)

> **Schicht 3 von 3 — PLATZHALTER.** Diese Capability ist **bewusst vertagt** (Q4 verbindlich). Sie wird in diesem Durchgang **nicht implementiert**; diese Datei hält den Scope, die offenen Punkte und die zusätzlichen Schutzanforderungen fest, damit ein späteres Board-Item sauber andocken kann. **Es entsteht hier KEIN Board-Item zur Umsetzung.**

## Zweck (geplant)
Zwei destruktive/risikoreiche VPS-Operationen, die über den Create/Start/Stop-Lifecycle ([[vps-provider-boundary]]) hinausgehen:
- **Rebuild** — ein **bestehender** Server wird destruktiv neu aufgesetzt (Image neu, Default-Setup via cloud-init erneut durchlaufen). **Datenverlust** auf dem Zielserver.
- **Backup/Snapshot** — Sicherung/Wiederherstellung des Server-Zustands über die jeweilige Provider-API.

## Warum vertagt
- Rebuild ist **destruktiv** (löscht bestehende Server-Daten) und braucht eine stärkere Guardrail-Stufe als Create/Start/Stop (siehe Schutzanforderungen unten).
- Backup ist provider-seitig sehr unterschiedlich modelliert (Snapshots vs. Backups vs. Images, teils kostenpflichtig zubuchbar) und erfordert eigene Recherche je Provider.
- Beide sind für den Erst-Durchgang (Multi-Provider create/start/stop + cloud-init-Setup) nicht erforderlich.

## Geplante Schutzanforderungen (für das spätere Item vorzumerken — NICHT jetzt umsetzen)
- **Bestätigungstoken / Tipp-Bestätigung:** Rebuild ist destruktiv → über die Access-Wand + Audit hinaus ein **expliziter Bestätigungsschritt** (z.B. Eingabe des Servernamens, „type-to-confirm"), anders als bei Create/Start/Stop (dort genügt laut Q4-Default Access + Audit ohne Zusatztoken).
- **Audit-First** mit klarer Kennzeichnung der Destruktivität.
- **Idempotenz/Atomarität:** klares `{result, reason}`, kein inkonsistenter Teilzustand.
- **Provider-Capability-Flags:** Rebuild/Backup je Provider als `supported`/`unsupported` ausweisen (analog [[vps-provider-boundary]] AC6), statt eine nicht unterstützte Aktion zu erzwingen.

## Offene Punkte (für die spätere Spec)
- Genaues Rebuild-Verhalten je Provider (Reimage-Endpunkt, ob cloud-init erneut greift).
- Backup-Modell je Provider (Snapshot vs. Backup-Add-on, Kosten, Restore-Pfad).
- Endgültige Guardrail-Stufe (Bestätigungstoken-Mechanik) — Abstimmung mit [[access-and-guardrails]].

## Nicht-Ziele (dieser Durchgang)
- **Jegliche Implementierung** von Rebuild oder Backup — bewusst vertagt (Q4).

## Abhängigkeiten (geplant)
- [[vps-provider-boundary]] (Lifecycle-Boundary, an den Rebuild/Backup als weitere Aktionen andocken).
- [[vps-cloud-init-setup]] (Rebuild würde das Default-Setup erneut nutzen).
- [[access-and-guardrails]] (verstärkte Guardrail/Bestätigung für destruktive Aktion).
