---
id: settings-shell
title: Settings-Ansicht — Zahnrad-Einstieg & Integrations-Sektionen (Grundgerüst)
status: draft
version: 1
---

# Spec: Settings-Ansicht (`settings-shell`)

> **Schicht 3 von 3.** Testbares Verhalten + Verträge, sprach-/paradigma-unabhängig.
> **Source of Truth** für `coder`, `tester`, `reviewer`.

## Zweck
Eine **zentrale Einstellmaske** für die Admin-Konsole, bequem über ein **Zahnrad-Bedienelement** in der App-Shell-Navigation (nicht als fünfte Einstiegs-Kachel) erreichbar und deep-linkbar. Sie bündelt die Konfiguration aller Integrationen in klar getrennten **Sektionen** (GitHub, Cloudflare, Hetzner/VPS, SSH-Keys). **Dieses Paket liefert nur das Gerüst**: das Zahnrad, die deep-linkbare Settings-Ansicht und die leeren, beschrifteten Sektionen. Das eigentliche Anlegen/Ändern/Löschen von Credentials liefert [[settings-credentials]]; die SSH-Key-Verwaltung samt VPS-Provisionierung liefert [[settings-ssh-keys]].

## Verhalten
1. In der App-Shell-Navigation ist ein **Zahnrad-Bedienelement** (Settings/Einstellungen) aus **jeder** Ansicht und vom Einstiegs-Panel aus sichtbar und aktivierbar (Maus **und** Tastatur).
2. Aktivieren des Zahnrads öffnet die **Settings-Ansicht** und ändert die Route auf die Settings-Kennung.
3. Die Settings-Ansicht ist **deep-linkbar**: ein direkter Aufruf mit der Settings-Route (z.B. `#/settings`) öffnet sie direkt; Browser-Vor/Zurück verhält sich wie für die übrigen Ansichten ([[app-shell-navigation]]).
4. Die Settings-Ansicht trägt einen erkennbaren Titel („Einstellungen") und zeigt **genau vier** klar beschriftete Sektionen: *GitHub*, *Cloudflare*, *Hetzner / VPS*, *SSH-Keys*.
5. Jede Sektion trägt eine kurze Beschreibung, welche Credentials/Daten sie aufnimmt; im Grundgerüst sind die Sektionen **leere Container** (Platzhalter „folgt"), ohne Backend-Aufruf.
6. Aus der Settings-Ansicht führt die Navigation (Home / andere Ansichten) wie aus jeder anderen Ansicht zurück; das Zahnrad bleibt sichtbar.
7. Die Settings-Ansicht ist **kein** Bestandteil der Einstiegs-Panel-Kacheln; das Panel zeigt weiterhin genau fünf Kacheln (kein Funktionsverlust gegenüber [[app-shell-navigation]]).

## Acceptance-Kriterien
- **AC1** — Ein Zahnrad-Bedienelement (Settings) ist in der Navigation aus jeder Ansicht **und** vom Einstiegs-Panel aus sichtbar und per Maus **und** Tastatur (Tab + Enter/Space) aktivierbar.
- **AC2** — Aktivieren des Zahnrads öffnet die Settings-Ansicht und setzt die Settings-Route; die Settings-Ansicht zeigt einen erkennbaren Titel „Einstellungen".
- **AC3** — Die Settings-Ansicht ist per Deep-Link (Settings-Route) direkt erreichbar; Browser-Zurück/Vor navigiert konsistent zur übrigen Shell, eine unbekannte Route fällt weiterhin auf das Einstiegs-Panel zurück.
- **AC4** — Die Settings-Ansicht zeigt **genau vier** beschriftete Sektionen: *GitHub*, *Cloudflare*, *Hetzner / VPS*, *SSH-Keys*; im Grundgerüst löst keine Sektion einen Backend-Aufruf aus.
- **AC5** — *Settings ist NICHT als Kachel* im Einstiegs-Panel (Zahnrad in der Navigation); die Fabrik-Ansicht und die übrigen Ansichten bleiben unverändert erreichbar. *(Fortschreibung: die ursprüngliche „genau fünf Kacheln"-Aussage bezog sich auf den damaligen Stand; die Panel-Kachelzahl wird nun durch [[team-view-frontend]] (Team-Kachel) und [[dashboard-deployment-tile]] (Deployments-Kachel) bestimmt — maßgeblich ist dort. Unverändert gilt: das Zahnrad/Settings ist **keine** Kachel.)*
- **AC6** — Aus der Settings-Ansicht ist die Rückkehr zum Einstiegs-Panel und der Wechsel zu jeder anderen Ansicht möglich; das Zahnrad bleibt sichtbar.
- **AC7** — Die Settings-Ansicht ist hinter der bestehenden Cloudflare-Access-Mauer erreichbar; das Grundgerüst führt **keine** view-spezifische Autorisierung und **keine** neuen Secrets/Backend-Endpunkte ein.

## Verträge
- **Routing (client-seitig):** stabile Kennung `settings`; Mechanismus (History/Hash) wie in [[app-shell-navigation]]. Deep-Link + Browser-Verlauf müssen erfüllt sein.
- **Keine neuen Backend-Endpunkte** in diesem Paket. Die Credential-/SSH-Endpunkte definieren [[settings-credentials]] und [[settings-ssh-keys]].
- **Keine erzwungene neue Abhängigkeit:** Zahnrad-Icon und Sektions-Layout mit minimalem Footprint (konsistent mit `docs/design.md`).

## Edge-Cases & Fehlerverhalten
- Unbekannte/abgelaufene Route → Fallback auf Einstiegs-Panel (wie [[app-shell-navigation]]).
- Direkter Deep-Link auf `settings` ohne Access-Cookie → die bestehende Access-Mauer greift **vor** dem Frontend.
- Schmale Viewports (< 768 px): Zahnrad bleibt erreichbar; Sektionen stapeln (konsistent mit `docs/design.md`).

## NFRs
- **A11y (WCAG 2.1 AA):** Zahnrad mit zugänglichem Namen (z.B. `aria-label="Einstellungen"`), sichtbarer Fokus, Touch-Target ≥ 44 px; Sektionen als Überschriften-Struktur; aktive Ansicht für Screenreader erkennbar (`aria-current`).
- **Sicherheit (Floor):** kein neues Secret im Frontend-Bundle; keine Umgehung der Access-Mauer.
- **Performance:** Settings-Wechsel ohne Voll-Reload (client-seitiger View-Wechsel).

## Nicht-Ziele
- Anlegen/Ändern/Löschen von Credentials (→ [[settings-credentials]]).
- SSH-Key-Verwaltung und VPS-Provisionierung (→ [[settings-ssh-keys]]).
- Settings als fünfte Einstiegs-Kachel (bewusst Zahnrad in der Navigation).

## Defaults (mangels Rückfrage festgelegt)
- **D1** — Einstieg über **Zahnrad in der Navigation**, nicht als fünfte Kachel (entspricht Anforderungstext „bequem wie über ein Zahnrad erreichbar").
- **D2** — Settings-Route-Kennung = `settings`.
- **D3** — Genau vier Sektionen, fest verdrahtet (GitHub, Cloudflare, Hetzner/VPS, SSH-Keys); weitere „weitere Credentials" werden als generische Schlüssel/Wert-Einträge in [[settings-credentials]] modelliert, nicht als eigene Sektion im Gerüst.

## Abhängigkeiten
- [[app-shell-navigation]] (Container/Routing/Navigation — das Zahnrad erweitert die Navigationsleiste).
- [[access-and-guardrails]] (Access-Mauer davor, unverändert).
- Liefert das Sektions-Gerüst für [[settings-credentials]] und [[settings-ssh-keys]].
</content>
</invoke>
