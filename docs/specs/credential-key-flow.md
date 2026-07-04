---
id: credential-key-flow
title: Key-Flow-Doku (credential-key-flow.md + Mermaid) + ADR-014-Ergänzung
status: draft
area: einstellungen
version: 1
---

# Spec: Key-Flow-Doku + ADR-014-Ergänzung (`credential-key-flow`)

> **Schicht 3 von 3.** Diese Spec ist eine **Dokumentations-Lieferung** (durable docs), keine App-Code-Änderung. Acceptance = die geforderten Inhalte existieren, sind konsistent zu [[credential-master-key-decoupling]] / [[credential-key-status-transparency]] / ADR-014, und enthalten **keine** Geheimnisse.

## Zweck
Die zwei getrennten Geheimnisse (GPG-Passphrase vs. Store-Master-Key), ihre zwei Bezugsmodi (autonom/interaktiv), die Prioritätskette und die Datei-/Item-Topologie sind heute über ADR-007/ADR-014, Entrypoint und Compose verstreut und nach der Entkopplung ([[credential-master-key-decoupling]]) verwirrungsträchtig. Diese Lieferung schafft **ein** durables Referenzdokument `docs/architecture/credential-key-flow.md` (Tabellen + Mermaid-Diagramm + Prioritätskette + Entkopplungs-Erklärung) und zieht **ADR-014** in `docs/architecture.md` entsprechend nach.

## Verhalten
1. **Neues Dokument `docs/architecture/credential-key-flow.md`** wird angelegt (Verzeichnis `docs/architecture/` neu) mit folgenden Pflicht-Abschnitten:
   - **(a) Tabellen** über (i) **Geheimnisse** (Name, Zweck, Quelle/Bitwarden-Item, Env-Var), (ii) **Dateien** (`.env`, `.env.gpg`, `secrets.enc.json`, ggf. `gpg.pass` — Inhalt, Verschlüsselung, Speicherort), (iii) **Ablauf** (Boot autonom / Recovery interaktiv).
   - **(b) Mermaid-Diagramm** mit beiden Ketten **und** dem Recovery-Pfad:
     - Bitwarden-Item `studis-softwareschmiede-gpg-passphrase` → `GPG_PASSPHRASE` → `.env.gpg` (GitHub-Auth).
     - Bitwarden-Item `dev-gui-cred-master-key` → `DEVGUI_CRED_MASTER_KEY` → scrypt → AES-Key → `secrets.enc.json`.
     - Dialog-Recovery-Pfad: locked → Bitwarden-Dialog → `unlock(...)` → `.env`-Persistenz (`DEVGUI_CRED_MASTER_KEY`).
   - **(c) Prioritätskette** (explizit gesetzter Key/`.env` > `DEVGUI_CRED_MASTER_KEY` > `DEVGUI_CRED_MASTER_KEY_FILE` > deprecated `CRED_MASTER_KEY(_FILE)` > Dialog-Recovery) — wortgleich zur Festlegung in [[credential-master-key-decoupling]] §2.
   - **(d) Entkopplung** `GPG_PASSPHRASE` vs. `DEVGUI_CRED_MASTER_KEY`: was jedes öffnet, warum getrennt, dass der alte Entrypoint-Fallback entfernt wurde.
2. **ADR-014-Ergänzung in `docs/architecture.md`:** Die ADR-014-Vollfassung wird um die getroffenen Entscheidungen ergänzt: (i) **zwei Modi** (autonom/interaktiv) als explizite Bezugswege, (ii) **Entkopplung** des Store-Keys von `GPG_PASSPHRASE`, (iii) **Benennung** `DEVGUI_CRED_MASTER_KEY` + Bitwarden-Item `dev-gui-cred-master-key`, (iv) Verweis auf `docs/architecture/credential-key-flow.md` als durable Detailquelle. Der ADR-Status/Datum-Kopf wird konsistent fortgeschrieben.
3. **Konsistenz-Pflicht:** Env-Namen, Item-Namen, Prioritätskette und `keySource`-Werte im Dokument müssen mit [[credential-master-key-decoupling]] und [[credential-key-status-transparency]] übereinstimmen (eine Quelle der Wahrheit, keine Drift).
4. **Sicherheits-Floor (hart):** Das Dokument enthält **keinerlei** echte Geheimnis-Werte (keine Beispiel-Keys, keine echten Passphrasen) — nur Namen/Bezeichner/Flussbeschreibungen.

## Acceptance-Kriterien
- **AC1** — `docs/architecture/credential-key-flow.md` existiert und enthält die Tabellen aus Verhalten §1a (Geheimnisse / Dateien / Ablauf).
- **AC2** — Das Dokument enthält ein **Mermaid-Diagramm** (```mermaid-Block), das beide Geheimnis-Ketten (GPG-Passphrase → `.env.gpg`; `dev-gui-cred-master-key` → `DEVGUI_CRED_MASTER_KEY` → `secrets.enc.json`) **und** den Dialog-Recovery-Pfad zeigt.
- **AC3** — Das Dokument nennt die **Prioritätskette** identisch zu [[credential-master-key-decoupling]] §2 und erklärt die **Entkopplung** `GPG_PASSPHRASE` vs. `DEVGUI_CRED_MASTER_KEY` (jeweils was geöffnet wird, warum getrennt, Wegfall des alten Fallbacks).
- **AC4** — ADR-014 in `docs/architecture.md` ist um zwei Modi, Entkopplung und Benennung (`DEVGUI_CRED_MASTER_KEY` / `dev-gui-cred-master-key`) ergänzt und verweist auf `docs/architecture/credential-key-flow.md`.
- **AC5** — Alle Env-/Item-Namen, die Prioritätskette und `keySource`-Werte im Dokument stimmen mit [[credential-master-key-decoupling]] und [[credential-key-status-transparency]] überein (keine widersprüchlichen Namen).
- **AC6** — Das Dokument und die ADR-Ergänzung enthalten **keine** echten Geheimnis-Werte (nur Namen/Bezeichner/Flussbeschreibung).

## Verträge
- **Neue Datei:** `docs/architecture/credential-key-flow.md` (Markdown; mind. Abschnitte a–d aus Verhalten §1; Mermaid-Codeblock).
- **Geänderte Datei:** `docs/architecture.md` (ADR-014-Vollfassung ergänzt; ADR-Listeneintrag ggf. nachgezogen).
- Keine App-Code-/Compose-/Entrypoint-Änderung in diesem Item (die liefern Item A/B).

## Edge-Cases & Fehlerverhalten
- Sollte das Mermaid-Diagramm in der Render-Pipeline nicht unterstützt werden, bleibt es dennoch als lesbarer Code-Block valide (kein Build-Bruch — reine Doku).

## NFRs
- **Sicherheit (Floor, hart):** keine echten Geheimnisse im Dokument.
- **Wartbarkeit:** ein durables Referenzdokument statt verstreuter Hinweise; Single Source of Truth für den Key-Flow.

## Nicht-Ziele
- App-Code-/Entrypoint-/Compose-Änderungen → [[credential-master-key-decoupling]] / [[credential-key-status-transparency]].
- Rotation → [[credential-key-rotation]].

## Abhängigkeiten
- [[credential-master-key-decoupling]] (Namen + Prioritätskette — inhaltlich vorausgesetzt).
- [[credential-key-status-transparency]] (`keySource`-Werte — inhaltlich vorausgesetzt).
- ADR-014 / ADR-007 in `docs/architecture.md`.
