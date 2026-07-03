---
id: settings-panel-navigation
title: Settings-Panel — linke Menü-Navigation (Kategorien statt Scroll-Monolith)
status: active
version: 1
---

# Spec: Settings-Panel-Navigation (`settings-panel-navigation`)

> **Schicht 3 von 3.** Testbares **Verhalten + Verträge**, sprach-/paradigma-unabhängig (Intent, keine Idiome/Klassen).
> **Source of Truth** für `coder` (baut daraus), `tester` (testet die Acceptance-Kriterien), `reviewer` (prüft den Diff dagegen — hartes Drift-Gate).

## Zweck
Der ~5.700-Zeilen-Scroll-Monolith `client/src/SettingsView.jsx` (neun Sektionen + Bitwarden-Unlock-Banner) wird auf eine **linke Menü-Navigation** umgestellt: links eine klickbare, deep-linkbare Kategorie-Liste, rechts der Parameterbereich **genau einer** gewählten Kategorie. Die Umstellung ist **reine Umverpackung** — bestehende Sektions-Komponenten (Logik, State, Props, Endpunkte, deren AC) bleiben **unverändert**; es kommen nur Gruppierung, Navigation, Layout, Routing und A11y-Semantik hinzu.

## Verhalten
1. Die Einstellungen-Ansicht zeigt eine **feste Menge von 7 Kategorien** in fester Reihenfolge (Setup-Reihenfolge: Grundlage → Zugang → Sicherheit → laufender Betrieb → Auffangbecken). Zu jedem Zeitpunkt ist **genau eine** Kategorie aktiv und ihr Parameterbereich sichtbar (kein Accordion aller Kategorien gleichzeitig).
2. Die bestehenden `<section>`-Blöcke werden gemäß fester Zuordnungstabelle (§Verträge) auf die 7 Kategorien verteilt; die inneren Sektions-Komponenten und ihre `id`/`aria-labelledby`-Anker bleiben unverändert.
3. Der Bitwarden-Unlock-Banner ist **keine** Kategorie: er erscheint kategorieübergreifend oberhalb von Nav+Content, solange `credentialStatus !== null` (unverändertes Anzeigekriterium).
4. Kategorie-Wechsel per Maus (Klick), Tastatur (Pfeiltasten/Home/End) und Deep-Link/Browser-Historie sind gleichwertige Wege, dieselbe Kategorie zu aktivieren.
5. Der „Zurück zum Panel"-Button steht in der Kopfzeile (neben dem Titel), nicht im Inhalt einer Kategorie.
6. Ab ≥ 1024 px erscheint die Nav als linke Spalte fester Breite; unter 1024 px als horizontale, scrollbare Tab-Leiste oberhalb des Inhalts — kein Hamburger/Collapse-Icon.

**Bindende Design-Grundlage:** `docs/design.md`, Abschnitt „Settings-Panel Navigation" (Entscheidungen **D1–D20**). Die Acceptance-Kriterien AC1–AC20 übernehmen D1–D20 **1:1** (gleiche Nummerierung); der dortige Text ist bei Detailfragen (Slugs, Farbwerte, Markup, Breakpoint) maßgeblich.

## Acceptance-Kriterien
Jedes AC entspricht der gleichnummerierten Design-Entscheidung in `docs/design.md` §„Settings-Panel Navigation" / Abschnitt 5.

- **AC1** (D1) — Genau **7 Kategorien** in fester Reihenfolge: Workspace, Zugänge & Schlüssel, Sicherung, Benachrichtigungen, Automatisierung, Integrationen, Diverses.
- **AC2** (D2) — Zuordnung bestehender Sektionen zu Kategorien gemäß Tabelle (§Verträge) ist verbindlich; insbesondere wird `WorkspacePathSection` aus der bisherigen GitHub-Sektion **herausgelöst** und bildet die eigenständige Kategorie *Workspace*.
- **AC3** (D3) — Der Bitwarden-Unlock-Banner ist keine Kategorie; er erscheint kategorieübergreifend oberhalb von Nav+Content genau dann, wenn `credentialStatus !== null` (unverändertes Anzeigekriterium).
- **AC4** (D4) — Ab ≥ 1024 px: linke Nav-Spalte fester Breite **220 px**. Unter 1024 px: horizontale, scrollbare Tab-Leiste (`overflow-x: auto`) oberhalb des Content-Bereichs. **Kein** Hamburger/Collapse-Icon.
- **AC5** (D5) — Nav-Item Mindesthöhe **44 px**; Innenabstand ≥ 10 px vertikal / 16 px horizontal (Desktop-Spalte und Mobile-Tabs gleichermaßen).
- **AC6** (D6) — Aktiver Zustand: Hintergrund `#1e293b`, linker Rahmen `3px solid #3b82f6`, Text `#e5e7eb`, `font-weight: 700`.
- **AC7** (D7) — Inaktiver Zustand: Hintergrund transparent, Text `#9ca3af`, linker Rahmen `3px solid transparent` (Platz reserviert, kein Layout-Sprung bei Wechsel).
- **AC8** (D8) — Hover-Zustand (nur `:hover`): Hintergrund `#1e293b`, **kein** linker Rahmen, **kein** Fettdruck — Unterscheidung zu Aktiv ausschließlich über Rahmen/Fettdruck/Textfarbe.
- **AC9** (D9) — Sichtbarer Fokus via `:focus-visible`-Outline `2px solid #3b82f6`, `outline-offset: -2px`, als **eigene CSS-Regel in `client/index.html`** (analog `#trigger-arg:focus-visible`; Inline-Style-Objekte können `:focus-visible` nicht abbilden).
- **AC10** (D10) — Nav-Markup: `<nav aria-label="Einstellungs-Kategorien">` > Container mit `role="tablist"` (`aria-orientation="vertical"` ≥ 1024 px, `"horizontal"` darunter) > je Kategorie ein `<button role="tab" id="settings-tab-<slug>" aria-selected={bool} aria-controls="settings-panel-<slug>">`.
- **AC11** (D11) — Content-Markup je Kategorie: `<div role="tabpanel" id="settings-panel-<slug>" aria-labelledby="settings-tab-<slug>" tabIndex={0}>`; genau **ein** Tabpanel gleichzeitig sichtbar (kein Accordion aller Kategorien).
- **AC12** (D12) — Tastatur: Pfeil-runter/-rechts bzw. -hoch/-links (je nach Orientierung) **bewegt und aktiviert sofort** die benachbarte Kategorie (automatic activation); `Home`/`End` springt zur ersten/letzten Kategorie; **Roving Tabindex** (nur aktiver Tab `tabIndex=0`, alle anderen `-1`) — die gesamte Nav ist **ein** Tab-Stopp.
- **AC13** (D13) — Deep-Link-Muster `#/settings/<slug>` mit den 7 Slugs `{workspace, zugaenge, sicherung, benachrichtigungen, automatisierung, integrationen, diverses}`; fehlendes (`#/settings`) oder unbekanntes Sub-Segment → Default-Kategorie **`workspace`**.
- **AC14** (D14) — Browser Vor/Zurück wechselt die Kategorie wie jede andere Route.
- **AC15** (D15) — `SettingsView.jsx` zerfällt in **Orchestrierungs-Shell** (bestehender State/Effects/Fetch-Code unverändert) + **`SettingsNav`-Komponente** + **7 Kategorie-Wrapper-Komponenten** (eine Datei je Kategorie); bestehende Sektions-Komponenten (`WorkspacePathSection`, `BackupSection` inkl. `RestoreSection`, `SshKeysSection`, `NotificationSection`, `MiscSection`, `NightWatchSettings`, `ObsidianVaultPathSection`, `CredentialField`, `BitwardenUnlockDialog`) werden **unverändert** importiert/gerendert (reine Umverpackung, keine Logik-/Prop-/Endpunkt-/AC-Änderung).
- **AC16** (D16) — Bestehende `id`/`aria-labelledby`-Werte der `<section>`-Blöcke (z.B. `settings-section-github`, `settings-section-nightwatch`) bleiben unverändert erhalten.
- **AC17** (D17) — Der „Zurück zum Panel"-Button steht in der **Kopfzeile** (neben dem Titel), kategorieübergreifend, nicht im Inhalt eines Tabpanels.
- **AC18** (D18) — Gesamtcontainer-`max-width` wächst von 720 px auf **~1000 px** (220 Nav + 24 Gap + 720 Content + Rand), weiterhin zentriert (`styles.view.alignItems: center` unverändert).
- **AC19** (D19) — **Kein** Screenreader-Doppel-Announcement zwischen Tab-Label (Kategorie) und Sektions-`<h2>` im Tabpanel — beide bleiben unterschiedliche, nicht redundante Texte.
- **AC20** (D20) — Alle Nav-Farb-/Kontrast-Paarungen nutzen **ausschließlich** bereits im Projekt verifizierte Tokens (`#9ca3af`/`#111`, `#e5e7eb`/`#1e293b`, `#3b82f6`-Akzent) — keine neuen, ungeprüften Farbwerte.

## Verträge

**Kategorie-Zuordnung (verbindlich, D2 — Slug ∈ Deep-Link-Muster):**

| # | Kategorie (Label) | Slug | Enthält (bestehende Komponenten/Sektionen, unverändert) |
|---|---|---|---|
| 1 | Workspace | `workspace` | `WorkspacePathSection` (aus GitHub-Sektion herausgelöst) |
| 2 | Zugänge & Schlüssel | `zugaenge` | GitHub-Credential-Felder, Cloudflare-Credential-Felder, VPS-Provider-Credential-Felder, `SshKeysSection` |
| 3 | Sicherung | `sicherung` | `BackupSection` (inkl. Ziel-Konfiguration + Remote-Zugangsdaten + intern gerendertem `RestoreSection`) |
| 4 | Benachrichtigungen | `benachrichtigungen` | `NotificationSection` (ntfy) |
| 5 | Automatisierung | `automatisierung` | `NightWatchSettings` (inkl. Auto-Retro-Schalter) |
| 6 | Integrationen | `integrationen` | `ObsidianVaultPathSection` (Obsidian-Vault-Pfad) |
| 7 | Diverses | `diverses` | `MiscSection` („Weitere Credentials") |

- **Routing (client-seitig):** Hash-Muster `#/settings/<slug>` analog dem bestehenden `#/factory/<repo>`-Muster in `client/src/useHashRouter.js` (`parseHashFull`/`factoryToHash` als Vorbild für `settingsCategoryToHash` + erweiterte `parseHashFull`-Logik). Kein neuer Backend-Endpunkt.
- **Orchestrierungs-Shell → Wrapper:** die Shell reicht die benötigten Props/Callbacks (`credentials`, `sshKeys`, `workspacePath`, `workspaceHealth`, `obsidianVaultPath`, `credentialStatus`, `load`, `reloadWorkspacePath`, `reloadWorkspaceHealth`, `reloadObsidianVaultPath`, `reloadCredentialStatus`, `fetchFn`, `getMeta`, `miscItems`, `setSshKeys`) unverändert an die jeweiligen Kategorie-Wrapper durch (mehrere Kategorien teilen sich dieselben Daten, z.B. `credentials` in Sicherung, Zugänge & Schlüssel und Diverses).
- **Keine neuen Secrets, keine neue Autorisierung, keine Backend-Änderung.** Die Access-Mauer bleibt unverändert davor.

## Edge-Cases & Fehlerverhalten
- Direkter Aufruf `#/settings` ohne Sub-Segment oder mit unbekanntem Slug → Default-Kategorie `workspace` (analog Fallback-auf-`panel`-Verhalten unbekannter Top-Level-Hashes).
- `credentialStatus === null` (Status noch nicht geladen / Fehler beim Laden) → Bitwarden-Banner bleibt ausgeblendet; Nav+Content bleiben funktionsfähig.
- Schmale Viewports (< 1024 px): Nav klappt in horizontale, scrollbare Tab-Leiste; Kategorien bleiben jederzeit mit einem Klick erreichbar (kein Öffnen/Schließen-Schritt).
- Bestehende Fehlerpfade der inneren Sektionen (`loadError`, `sshLoadError`, `workspacePathError`, `obsidianVaultPathError`) bleiben unverändert im jeweiligen Kategorie-Kontext sichtbar.

## NFRs
- **A11y (WCAG 2.1 AA):** vollständige Tastatur-Bedienbarkeit (Roving Tabindex, ein Tab-Stopp), sichtbarer `:focus-visible`-Fokus, Touch-Targets ≥ 44 px, `aria-selected`/`aria-controls`/`aria-labelledby`-Verdrahtung, aktiver Zustand nie nur über Farbe (Rahmen + Fettdruck + Textfarbe + `aria-selected`). Nur projekt-verifizierte Kontrast-Tokens.
- **Sicherheit (Floor):** kein neues Secret im Frontend-Bundle, keine Umgehung der Access-Mauer, keine Änderung an Credential-Endpunkten oder deren write-only-Semantik.
- **Performance:** Kategorie-Wechsel client-seitig ohne Voll-Reload.

## Nicht-Ziele
- Keine Änderung an Logik, Props, Endpunkten oder AC der bestehenden Sektions-Komponenten (reine Umverpackung).
- Keine neuen Kategorien über die 7 definierten hinaus; keine Umbenennung/Neusortierung außerhalb der D1-Reihenfolge.
- Kein neues CSS-Custom-Properties-System — die etablierte Inline-Style-Konvention in `SettingsView.jsx` wird fortgeführt (nur die `:focus-visible`-Regel lebt in `client/index.html`, da Inline-Styles Pseudoklassen nicht abbilden).
- Kein neuer Breakpoint — der bestehende 1024-px-Responsive-Floor wird wiederverwendet.

## Abhängigkeiten
- [[settings-shell]] (Settings-Einstieg/Route/Zahnrad — dieses Paket strukturiert deren Inhalt um).
- [[app-shell-navigation]] (Hash-Routing/`useHashRouter` — Vorbild für das `#/settings/<slug>`-Deep-Link-Muster).
- [[settings-credentials]], [[settings-ssh-keys]], [[workspace-path-config]], [[obsidian-vault-config]], [[taktgeber-nachtwaechter]], [[credential-backup]], [[push-notifications]] — liefern die inneren Sektions-Komponenten, die hier **unverändert** eingebettet werden.
- `docs/design.md` §„Settings-Panel Navigation" (D1–D20) — bindende Design-Grundlage.
