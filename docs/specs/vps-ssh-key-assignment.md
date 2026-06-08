---
id: vps-ssh-key-assignment
title: SSH-Key-Zuordnung root/alex für VPS-Create (aus settings-ssh-keys)
status: draft
version: 2
---

# Spec: SSH-Key-Zuordnung root/alex für VPS-Create (`vps-ssh-key-assignment`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer` (Drift-Gate). Security-relevant.

## Zweck
Beim **Create-from-scratch** ([[vps-provider-boundary]]) bekommen die zwei Default-Benutzer (`root`, `alex`) **distinkte** SSH-Public-Keys. Diese Capability klärt, **wie der Nutzer im UI pro User-Rolle (root/alex) ein `settings-ssh-keys`-Label auswählt**, woher die Public-Keys stammen und wie sie an die cloud-init-Pipeline ([[vps-cloud-init-setup]]) gereicht werden — sodass sich der Nutzer danach mit demselben Key bequem auf allen so erstellten Servern anmelden kann.

> **Distinkte Keys je User (Q3 verbindlich):** `root` und `alex` erhalten jeweils einen **eigenen** Public-Key aus **separaten** `settings-ssh-keys`-Labels; kein gemeinsamer Key.

> **Querverweis (Key-Herkunft):** Ein Rollen-Label-Key kann **entweder** vom Nutzer hinterlegt **oder** direkt im Panel **erzeugt** werden ([[ssh-key-generation]]) — ein dort generierter ed25519-Public-Key ist sofort ein wählbares Label mit gesetztem Public-Key für diese Zuordnung. Diese Spec bleibt davon im Scope unberührt: sie ordnet nur **vorhandene** Labels den Rollen `root`/`alex` zu, unabhängig davon, ob das Label hinterlegt oder generiert wurde.

## Verhalten
1. Die SSH-Public-Keys stammen aus der bestehenden Key-Verwaltung ([[settings-ssh-keys]] Stufe A) — hinterlegt **oder** im Panel erzeugt ([[ssh-key-generation]]): je **Benutzer-Label** (z.B. `root`, `alex`) ist dort ein Public-Key vorhanden.
2. Im VPS-Create-Formular ([[view-vps]]) ordnet der Nutzer **pro Ziel-User-Rolle** (`root`, `alex`) ein hinterlegtes `settings-ssh-keys`-Label zu — über eine Auswahl, die die verfügbaren Labels mit gesetztem Public-Key anbietet.
3. Sind die `settings-ssh-keys`-Labels für `root` und `alex` bereits eindeutig (gleichnamig), ist eine **Default-Zuordnung** zulässig (Label `root` → Ziel-User `root`, Label `alex` → Ziel-User `alex`), die der Nutzer übersteuern kann.
4. Beim Create löst das Backend die ausgewählten Labels in die zugehörigen **Public-Keys** auf (store-intern aus dem `CredentialStore`-Public-Key-Metadatum, ADR-007) und übergibt sie als `{ root, alex }` an die cloud-init-Pipeline ([[vps-cloud-init-setup]]).
5. Es werden **ausschließlich Public-Keys** weitergereicht; Private-Keys verlassen den `CredentialStore` über diesen Pfad **niemals**.
6. Fehlt für eine der beiden Ziel-Rollen ein zugeordneter/gesetzter Public-Key, ist Create **nicht** auslösbar (UI sperrt) bzw. wird vom Backend mit klarer 422 abgewiesen (kein Provider-Call).

## Acceptance-Kriterien
- **AC1** — Das Create-Formular bietet je Ziel-User-Rolle (`root`, `alex`) eine Auswahl der in [[settings-ssh-keys]] hinterlegten Labels **mit gesetztem Public-Key** an; Labels ohne Public-Key sind nicht wählbar.
- **AC2** — Der Nutzer ordnet `root` und `alex` jeweils ein Label zu; eine sinnvolle Default-Zuordnung (gleichnamiges Label → Rolle) ist vorbelegt und übersteuerbar. Die Zuordnung erlaubt **distinkte** Keys (verschiedene Labels für `root` vs. `alex`).
- **AC3** — Beim Create löst das Backend die gewählten Labels in die zugehörigen Public-Keys auf und übergibt `{ root: <publicKey>, alex: <publicKey> }` an die cloud-init-Pipeline; der `root`-Key landet in `/root/.ssh/authorized_keys`, der `alex`-Key in `~alex/.ssh/authorized_keys` (verifiziert über das erzeugte cloud-init in [[vps-cloud-init-setup]] AC4/AC5).
- **AC4** — Über diesen Pfad verlässt **nie** ein Private-Key den `CredentialStore`; nur Public-Keys werden aufgelöst/weitergereicht (Response/Log/Audit/WS/cloud-init enthalten keinen Private-Key).
- **AC5** — Fehlt für `root` oder `alex` ein gesetzter Public-Key (kein wählbares Label oder leere Zuordnung), ist Create im UI gesperrt; ein dennoch gesendeter Create-Request wird mit 422 (`errorClass: "missing-ssh-key"`) abgewiesen, **ohne** Provider-Call (konsistent mit [[vps-cloud-init-setup]] AC7).
- **AC6** — Die gewählte Label→Rolle-Zuordnung ist Teil des auditierten Create-Vorgangs (welche Labels für root/alex verwendet wurden), **ohne** Key-Geheimnisse im Audit.

## Verträge
- **Eingabe (Create-Request, Teil von [[vps-provider-boundary]] POST):** `{ sshKeyAssignment: { root: <label>, alex: <label> } }` (Label-Referenzen, **keine** rohen Keys vom Client).
- **Auflösung (intern):** Label → Public-Key über den `CredentialStore` (Public-Key-Metadatum, [[settings-ssh-keys]] / ADR-007). Ergebnis `{ root: <publicKey>, alex: <publicKey> }` → an [[vps-cloud-init-setup]].
- **UI-Datenquelle:** die wählbaren Labels kommen aus `GET /api/settings/ssh-keys` (nur Labels mit `publicKey` gesetzt; Public-Keys dürfen angezeigt werden).
- Kein neuer eigener Endpunkt zwingend nötig — die Zuordnung ist Bestandteil des Create-Requests; alternativ darf der `coder` einen schlanken Auflösungs-Helfer in der VPS-Boundary kapseln (Architektur-Detail).

## Edge-Cases & Fehlerverhalten
- Kein Label mit gesetztem Public-Key vorhanden → Create gesperrt; Hinweis, zuerst in [[settings-ssh-keys]] Keys zu hinterlegen.
- Gleiches Label für root **und** alex gewählt (nicht-distinkt) → erlaubt, aber UI weist auf nicht-distinkte Keys hin (Default ist distinkt; harte Distinktheit ist kein Muss, da der Nutzer bewusst denselben Key wählen darf — Q3-Default ist distinkt).
- Label referenziert einen zwischenzeitlich gelöschten Key → 422 `missing-ssh-key`, kein Provider-Call.
- Public-Key in ungültigem Format (sollte durch [[settings-ssh-keys]] AC4 verhindert sein) → Ablehnung vor Create.

## NFRs
- **Sicherheit (Floor, hart):** nur Public-Keys verlassen den Store auf diesem Pfad; nie Private-Keys; keine Keys als rohe Klartext-Eingabe vom Client beim Create (nur Label-Referenzen → kein Injection-Vektor für fremde Keys ohne Hinterlegung).
- **A11y:** Auswahl-Elemente je Rolle beschriftet (`root`, `alex`); Sperrgrund (fehlender Key) programmatisch zugeordnet.

## Nicht-Ziele
- Key-Erzeugung/Keygen (nur Auswahl hinterlegter Keys, wie [[settings-ssh-keys]]).
- Nachträgliches Injizieren auf **laufende** Server (das ist [[settings-ssh-keys]] Stufe B / `VpsProvisioner`).
- Mehr als zwei Default-Rollen (`root`, `alex` sind der fixierte Default dieses Durchgangs).

## Abhängigkeiten
- [[settings-ssh-keys]] (Quelle der Public-Keys je Label, Format-Validierung, CredentialStore-Ablage).
- [[ssh-key-generation]] (alternative Key-Herkunft: ein wählbares Label kann direkt im Panel generiert werden — Scope dieser Spec unberührt).
- [[vps-cloud-init-setup]] (Konsument der aufgelösten root-/alex-Public-Keys).
- [[vps-provider-boundary]] (Create-Request trägt die Label-Zuordnung).
- [[view-vps]] (UI der Zuordnung im Create-Formular).
