# Design-System — dev-gui

> Teil des Detailkonzepts (**UI-Domäne**). Bindend für den `coder`; Konformität (Kontrast/Spacing/A11y) prüft der `reviewer` via UI-Pack-Checklist. Detail-Ausarbeitung beim ersten Frontend-Item durch den `designer` — hier die Leitplanken.

## Tokens
- **Theme:** Dark-first (Entwickler-Konsole, viel Terminal). Hintergrund neutral-dunkel, ein Akzent (Aktion/Trigger), klare Statusfarben (grün=ready/done, amber=busy/running, rot=failed/cancelled/blocked).
- **Spacing:** 8-pt-Skala.
- **Typografie:** Monospace im Terminal-Pane; UI-Sans für Panels/Dashboard.

## Komponenten-Patterns
- **Terminal-Pane** — dominanter, scrollbarer xterm.js-Bereich; Verbindungs-Status sichtbar.
- **Status-Dashboard** — Karten je Projekt (offene Items, letzter CI-Lauf, Preview-Container mit klickbarer URL).
- **Flow-Trigger-Panel** — Projekt/Item wählen → eindeutiger Aktions-Button; bei aktivem Job sind Trigger **deaktiviert** (Lock sichtbar) + **Kill-Button** aktiv.
- **Audit-Ansicht** — chronologische Liste (Zeit · Identität · Befehl).

## Responsive / Breakpoints
Desktop-zuerst (Admin-Tool). Mind. lesbar/bedienbar ab ~1024 px; unter ~768 px Panels über das Terminal stapeln.

## Accessibility (WCAG 2.1 AA)
Kontrast berechnet (≥ 4.5:1 Text, ≥ 3:1 große/Status-Elemente), sichtbarer Fokus, volle Tastatur-Navigation (Terminal erhält Fokus bewusst, nicht als Falle), Touch-Targets ≥ 44 px. Statusfarben nie als einzige Bedeutung (Icon/Label dazu).

## „Arbeiten"-Layout (fabrik-arbeiten-layout, S-265)

Designer-Vorschlag für den Fabrik-„Arbeiten"-Reiter (`CockpitView.jsx`
`FactoryWorkspace`), seit der Board-Drain headless läuft (ADR-017,
[[headless-manual-drain]]) — kein dominantes eingebettetes Claude-Terminal
mehr nötig, weil der Board-Lauf dort keine Live-Ausgabe mehr erzeugt.

**Grundidee:** Die Aktions-/Button-Spalte wird PRIMÄRER Inhalt (statt bisher
neben einem dominanten Terminal-Pane zu stehen); das Terminal wandert an den
unteren Rand und ist per Checkbox ein-/ausblendbar (Default: aus).

**Anordnung (Desktop, ≥ ~768 px):**
1. **Aktions-Karten-Grid** (oben, scrollbar, füllt den verfügbaren Platz):
   die bisherigen Boxen — „Board abarbeiten" (inkl. Cost-Mode-Dropdown +
   Status/Bericht), „Idee", „Neue Story", das Trigger-Panel (adopt/preview/
   train/new-project + Kill) und das Status-Dashboard — werden statt in einer
   vertikalen Einzelspalte als **umbrechendes Karten-Grid** (`flex-wrap`,
   8-pt-Abstand; „Board abarbeiten"/„Idee"/„Neue Story" mit vollem Rahmen
   statt nur Unterlinie, Trigger-Panel/Dashboard behalten ihre bestehende
   `borderLeft`-Randlinie) nebeneinander angeordnet. Hierarchie: „Board abarbeiten" bleibt die erste/
   prominenteste Karte (Primäraktion), die übrigen folgen in bestehender
   Reihenfolge. Funktion/Verhalten jedes Buttons bleibt unverändert (gleiche
   Handler/Endpunkte) — nur Anordnung/Optik ändern sich.
2. **Terminal-Kontrollzeile** (unterer Rand, immer sichtbar, auch wenn das
   Karten-Grid darüber scrollt): eine Checkbox „Terminal einblenden"
   (Default: **aus**), Touch-Target ≥ 44 px, mit sichtbarem Fokusring.
3. **Terminal-Fläche** (nur bei aktivierter Checkbox, feste Höhe statt
   vollflächig-dominant): zeigt die Live-Ausgabe der verbleibenden
   interaktiven PTY-Befehle (adopt/preview/train/new-project + Kill,
   [[terminal-bridge]]). Aus-/Einblenden mountet/unmountet nur die
   Client-Ansicht — die PTY-Session läuft serverseitig unverändert weiter
   (kein Kill); beim erneuten Einblenden zeigt der Scrollback-Replay der
   Session den Verlauf.

**Unter ~768 px:** Die Karten des Aktions-Grids stapeln einspaltig (natürlicher
Zeilenumbruch durch `flex-wrap` + Mindestbreite je Karte); die
Terminal-Kontrollzeile und -Fläche bleiben unten, volle Breite.

**Zustände:** wie bisher — Busy-Lock (Trigger deaktiviert + Hinweistext),
Bestätigungsdialog vor „Board abarbeiten", Status/Fehler immer textlich (nie
nur Farbe).

## Settings-Panel Navigation (settings-panel-navigation, Owner-Anforderung 2026-07-02)

Designer-Vorgabe für den Umbau von `SettingsView.jsx` (~5.700-Zeilen-Monolith,
neun Sektionen + Bitwarden-Unlock-Dialog) auf eine **linke Menü-Navigation**:
links klickbare Kategorien, rechts der Parameterbereich der gewählten
Kategorie. Bindend für `coder`/`requirement`; Konformität prüft `reviewer`.

### 1. Navigationsstruktur — Kategorien

7 Kategorien, feste Reihenfolge (Setup-Reihenfolge: Grundlage → Zugang →
Sicherheit → laufender Betrieb → Auffangbecken):

| # | Kategorie (Label) | Slug (Deep-Link) | Enthält (bestehende Komponenten/Sektionen, unverändert) |
|---|---|---|---|
| 1 | **Workspace** | `workspace` | `WorkspacePathSection` — aus der bisherigen GitHub-Sektion herausgelöst |
| 2 | **Zugänge & Schlüssel** | `zugaenge` | GitHub-Credential-Felder, Cloudflare-Credential-Felder, VPS-Provider-Credential-Felder, `SshKeysSection` |
| 3 | **Sicherung** | `sicherung` | `BackupSection` (inkl. Ziel-Konfiguration + Remote-Zugangsdaten), `RestoreSection` |
| 4 | **Benachrichtigungen** | `benachrichtigungen` | `NotificationSection` (ntfy) |
| 5 | **Automatisierung** | `automatisierung` | `NightWatchSettings` (Nachtwächter inkl. Auto-Retro-Schalter, S-260/ADR-018) |
| 6 | **Integrationen** | `integrationen` | `ObsidianVaultPathSection` (Obsidian-Vault-Pfad, S-247) |
| 7 | **Diverses** | `diverses` | `MiscSection` („Weitere Credentials") |

**Begründung der Zuordnung:**
- **Workspace** eigenständig statt GitHub-Unterabschnitt: reine lokale
  Dateisystem-Konfiguration, fachlich unabhängig von GitHub-App-Credentials —
  die heutige Verschachtelung ist historisch, nicht fachlich begründet.
- **Zugänge & Schlüssel** bündelt GitHub/Cloudflare/VPS-Provider/SSH-Keys, weil
  alle vier dasselbe Interaktionsmuster teilen (`CredentialField`:
  gesetzt/nicht gesetzt, write-only) und denselben Zweck erfüllen — Zugang zu
  externen Systemen.
- **Sicherung** fasst Backup + Restore zusammen (bereits heute fachlich eine
  Einheit — Restore ist Unterabschnitt von Backup).
- **Benachrichtigungen** und **Automatisierung** bleiben 1:1 abgegrenzte,
  wachsende Themenblöcke (Nachtwächter hat mit dem Auto-Retro-Schalter gerade
  einen weiteren Baustein erhalten — verdient eine eigene, nicht überladene
  Kategorie statt eines langen Scroll-Blocks).
- **Integrationen** ist bewusst so benannt (nicht „Obsidian"), um künftige
  weitere Datenquellen-Integrationen ohne Umbenennung aufzunehmen.
- **Diverses** ist der bewusste Auffangort für generische, nicht
  integrations-gebundene Einträge (`MiscSection`) — Name spiegelt die heutige
  Sektionsbeschriftung „Weitere Credentials".
- Der **Bitwarden-Unlock-Status-Banner** ist **keine Kategorie** — er gated
  den Credential-Store kategorieübergreifend und bleibt oberhalb der
  Nav+Content-Fläche sichtbar (s. Layout, D3).

### 2. Layout-Spezifikation

**Struktur (≥ 1024 px — Breakpoint identisch mit dem bestehenden Responsive-
Floor oben in diesem Dokument):**

```
┌─────────────────────────────────────────────────────────┐
│ Einstellungen                          [← Zurück zum Panel] │  ← Kopfzeile
│ (Bitwarden-Unlock-Banner, falls credentialStatus !== null)  │  ← kategorieübergreifend
├───────────────┬───────────────────────────────────────────┤
│ Workspace     │                                             │
│ Zugänge & …   │   Tabpanel der gewählten Kategorie          │
│ Sicherung     │   (bestehende <section>-Blöcke unverändert) │
│ Benachricht.  │                                             │
│ Automatis.    │                                             │
│ Integration.  │                                             │
│ Diverses      │                                             │
└───────────────┴───────────────────────────────────────────┘
```

- **Nav-Spalte:** feste Breite **220px**, Hintergrund `#111` (wie bestehende
  `styles.section`-Hintergründe), `border-right: 1px solid #2a2a2a`.
- **Nav-Item:** Block-Button, volle Breite, Mindesthöhe **44px**, Padding
  `10px 16px`, Schriftgröße 14px, `border-left: 3px solid transparent`
  (Platz für Aktiv-Indikator reserviert — kein Layout-Sprung bei Wechsel).
  - **Inaktiv:** Hintergrund transparent, Text `#9ca3af` (im Projekt
    verifiziert ≥ 4.5:1 auf `#111`, s. bestehende Code-Kommentare).
  - **Hover** (nur `:hover`, pointer-fähige Geräte): Hintergrund `#1e293b`,
    Rahmen bleibt transparent, kein Fettdruck — Unterscheidung zum aktiven
    Zustand ausschließlich über Rahmenfarbe/Fettdruck (s.u.). Hover ist reine
    Komfort-Rückmeldung, kein WCAG-Pflichtkriterium — daher genügt die
    Wiederverwendung des bestehenden `#1e293b`-Tokens ohne eigene
    Kontrastprüfung.
  - **Aktiv:** Hintergrund `#1e293b`, `border-left: 3px solid #3b82f6`
    (gleicher Blauton wie der bestehende Fokusring, s.u.), Text `#e5e7eb`,
    `font-weight: 700` — Farbpaar `#e5e7eb`/`#1e293b` ist im Projekt bereits
    etabliert (z.B. `fieldStyles.input`).
- **Content-Spalte:** `flex: 1`, `max-width: 720px` (bestehender
  `styles.inner`-Wert unverändert übernommen), zeigt **genau eine** Kategorie
  gleichzeitig (kein Accordion aller Kategorien).
- **Abstand Nav↔Content:** 24px (3× 8-pt-Skala).
- **Gesamtcontainer:** `max-width` wächst von bisher 720px auf **~1000px**
  (220 Nav + 24 Gap + 720 Content + Rand), weiterhin zentriert
  (`styles.view.alignItems: center` unverändert).

**Unter 1024 px:** Die Nav klappt in eine **horizontale, scrollbare
Tab-Leiste** oberhalb des Content-Bereichs um (volle Breite, `overflow-x:
auto`, jedes Nav-Item Mindesthöhe 44px, horizontales Padding 16px).
*Entscheidung gegen Hamburger/Collapse-Icon:* die Kategorie-Liste bleibt so
**jederzeit sichtbar und mit einem Klick erreichbar** — kein zusätzlicher
Öffnen/Schließen-Schritt, passt zum Admin-Tool-Charakter (Desktop-zuerst,
aber kein Verstecken essenzieller Navigation bei schmalen Fenstern). Gleicher
Breakpoint (1024px) wie der bestehende globale Responsive-Floor — keine neue
Breakpoint-Größe eingeführt.

Kopfzeile (Titel + „Zurück zum Panel") und Bitwarden-Unlock-Banner bleiben in
**beiden** Layout-Varianten oberhalb der Nav/Tabs, nicht Teil eines
Tabpanel-Inhalts.

### 3. Accessibility (WCAG 2.1 AA)

- **Struktur:** `<nav aria-label="Einstellungs-Kategorien">` umschließt einen
  Container mit `role="tablist"` (`aria-orientation="vertical"` ≥1024px,
  `"horizontal"` darunter); je Kategorie ein
  `<button role="tab" id="settings-tab-<slug>" aria-selected={bool}
  aria-controls="settings-panel-<slug>" tabIndex={active ? 0 : -1}>`.
- **Tabpanel:** je Kategorie `<div role="tabpanel" id="settings-panel-<slug>"
  aria-labelledby="settings-tab-<slug>" tabIndex={0}>` — genau eines sichtbar.
  Bestehende `id`/`aria-labelledby`-Werte der inneren `<section>`-Blöcke
  (z.B. `settings-section-github`) bleiben unverändert erhalten.
- **Tastatur:** Pfeil-runter/-rechts bzw. -hoch/-links (je nach Orientierung)
  bewegt **und aktiviert sofort** die benachbarte Kategorie (automatic
  activation — schnelle Navigation ohne Zusatzschritt); `Home`/`End` springt
  zur ersten/letzten Kategorie; **Roving Tabindex** (nur aktiver Tab
  `tabIndex=0`, alle anderen `-1`) — die gesamte Nav ist **ein** Tab-Stopp.
- **Fokus-Ring:** `:focus-visible`-Outline `2px solid #3b82f6`,
  `outline-offset: -2px` (inset, damit der Ring bei vollbreiten Block-Buttons
  nicht vom Container beschnitten wird) — eigene CSS-Regel in
  `client/index.html`, analog dem bestehenden `#trigger-arg:focus-visible`-
  Muster (inline-Style-Objekte können `:focus-visible` nicht abbilden).
- **Touch-Targets:** Nav-Items ≥ 44px Höhe (Desktop-Spalte wie Mobile-Tabs).
- **Screenreader:** Tab-Label (Kategorie, z.B. „Zugänge & Schlüssel") und
  Sektions-`<h2>` innerhalb des Tabpanels (z.B. „GitHub", „Cloudflare") sind
  unterschiedliche, nicht redundante Texte — kein Doppel-Announcement.
- **Statusfarbe nie alleinige Bedeutung:** aktiver Zustand wird über
  Rahmenfarbe + Textfarbe + Fettdruck + `aria-selected` transportiert, nicht
  nur über Farbe.

### 4. Migrations-Hinweis für die Umsetzung

- `SettingsView.jsx` zerfällt in:
  - eine **Orchestrierungs-Shell** (bestehender State/Effects/Fetch-Code —
    `load`, `reloadWorkspacePath`, `reloadWorkspaceHealth`,
    `reloadObsidianVaultPath`, `reloadCredentialStatus`,
    `credentialStatus`/`showUnlockDialog` — bleibt **unverändert**, da mehrere
    Kategorien dieselben Daten konsumieren, z.B. `credentials` in „Sicherung",
    „Zugänge & Schlüssel" **und** „Diverses");
  - eine neue **`SettingsNav`-Komponente** (Tablist/Tabs, Responsive-Umschaltung,
    Tastatur-Handling wie oben);
  - **sieben Kategorie-Wrapper-Komponenten** (eine Datei je Kategorie, z.B.
    `client/src/settings/categories/WorkspaceCategory.jsx`,
    `ZugaengeCategory.jsx`, `SicherungCategory.jsx`, …), die jeweils die
    bestehenden `<section>`-Blöcke **unverändert** aus `SettingsView.jsx`
    übernehmen und die benötigten Props/Callbacks von der Shell durchreichen.
- Bestehende Sektions-Komponenten (`WorkspacePathSection`, `BackupSection`,
  `RestoreSection`, `SshKeysSection`, `NotificationSection`, `MiscSection`,
  `NightWatchSettings`, `ObsidianVaultPathSection`, `CredentialField`,
  `BitwardenUnlockDialog`) werden **unverändert** importiert/gerendert — reine
  Umverpackung, **keine** Logik-, Prop-, Endpunkt- oder AC-Änderung an diesen
  Komponenten.
- **URL-/State-Anker (Deep-Link):** Hash-Muster `#/settings/<slug>` analog dem
  bestehenden `#/factory/<repo>`-Muster in `client/src/useHashRouter.js`
  (`parseHashFull`/`factoryToHash` als Vorbild für eine neue
  `settingsCategoryToHash`/erweiterte `parseHashFull`-Logik). `<slug>` ∈
  `{workspace, zugaenge, sicherung, benachrichtigungen, automatisierung,
  integrationen, diverses}`. Fehlt das Sub-Segment (`#/settings`) oder ist es
  unbekannt, gilt Default-Kategorie **`workspace`** (analog dem bestehenden
  Fallback-auf-`panel`-Verhalten unbekannter Top-Level-Hashes). Browser
  Vor/Zurück wechselt die Kategorie wie jede andere Route.
- Der „Zurück zum Panel"-Button wandert aus dem Sektionen-Ende in die
  Kopfzeile (neben den Titel) — kategorieübergreifend, kein Teil eines
  Tabpanel-Inhalts.

### 5. Design-Entscheidungen (testbar)

- **D1** — Genau 7 Kategorien in fester Reihenfolge: Workspace, Zugänge &
  Schlüssel, Sicherung, Benachrichtigungen, Automatisierung, Integrationen,
  Diverses.
- **D2** — Zuordnung bestehender Sektionen zu Kategorien gemäß Tabelle in
  Abschnitt 1 ist verbindlich.
- **D3** — Bitwarden-Unlock-Banner ist keine Kategorie; erscheint
  kategorieübergreifend oberhalb von Nav+Content, wenn `credentialStatus !==
  null` (unverändertes Anzeigekriterium).
- **D4** — Ab ≥ 1024px: linke Nav-Spalte fester Breite 220px. Unter 1024px:
  horizontale, scrollbare Tab-Leiste oberhalb des Content-Bereichs. Kein
  Hamburger/Collapse-Icon.
- **D5** — Nav-Item Mindesthöhe 44px; Innenabstand ≥ 10px vertikal / 16px
  horizontal (Desktop-Spalte und Mobile-Tabs gleichermaßen).
- **D6** — Aktiver Zustand: Hintergrund `#1e293b`, linker Rahmen `3px solid
  #3b82f6`, Text `#e5e7eb`, `font-weight: 700`.
- **D7** — Inaktiver Zustand: Hintergrund transparent, Text `#9ca3af`.
- **D8** — Hover-Zustand (nur `:hover`): Hintergrund `#1e293b`, kein linker
  Rahmen, kein Fettdruck — Unterscheidung zu Aktiv ausschließlich über
  Rahmen/Fettdruck/Textfarbe.
- **D9** — Sichtbarer Fokus via `:focus-visible`-Outline `2px solid #3b82f6`,
  `outline-offset: -2px`, als eigene CSS-Regel in `client/index.html` (analog
  `#trigger-arg:focus-visible`).
- **D10** — Nav-Markup: `<nav aria-label="Einstellungs-Kategorien">` >
  `role="tablist"` (`aria-orientation` vertical/horizontal je Breakpoint) >
  je Kategorie `<button role="tab" aria-selected aria-controls id>`.
- **D11** — Content-Markup je Kategorie: `role="tabpanel"` mit `id`,
  `aria-labelledby`, `tabIndex={0}`; genau ein Tabpanel gleichzeitig sichtbar
  (kein Accordion aller Kategorien gleichzeitig).
- **D12** — Tastatur: Pfeiltasten (orientierungsabhängig) bewegen und
  aktivieren sofort (automatic activation); `Home`/`End` springen zur
  ersten/letzten Kategorie; Roving Tabindex (ein Tab-Stopp für die gesamte
  Nav).
- **D13** — Deep-Link-Muster `#/settings/<slug>` mit den 7 definierten Slugs;
  fehlendes/unbekanntes Sub-Segment → Default `workspace`.
- **D14** — Browser Vor/Zurück wechselt die Kategorie (wie bestehende
  Routen).
- **D15** — `SettingsView.jsx` zerfällt in Orchestrierungs-Shell +
  `SettingsNav` + 7 Kategorie-Wrapper-Komponenten; bestehende
  Sektions-Komponenten werden unverändert weiterverwendet (reine
  Umverpackung, keine AC-Änderung an bestehenden Sektionen).
- **D16** — Bestehende `id`/`aria-labelledby`-Werte der `<section>`-Blöcke
  bleiben unverändert (Innenstruktur je Kategorie).
- **D17** — „Zurück zum Panel"-Button steht in der Kopfzeile, nicht in einem
  Tabpanel.
- **D18** — Gesamtcontainer-`max-width` wächst von 720px auf ~1000px,
  weiterhin zentriert.
- **D19** — Kein Screenreader-Doppel-Announcement zwischen Tab-Label und
  Sektions-`<h2>` im Tabpanel.
- **D20** — Alle Nav-Farb-/Kontrast-Paarungen nutzen ausschließlich bereits im
  Projekt verifizierte Tokens (`#9ca3af`/`#111`, `#e5e7eb`/`#1e293b`,
  `#3b82f6`-Akzent) — keine neuen, ungeprüften Farbwerte.

### Annahmen

- Kein Board-Story-Bezug (S-Nummer) für diese Design-Erweiterung bekannt —
  Abschnitt referenziert stattdessen das Owner-Anforderungsdatum 2026-07-02.
- Breakpoint 1024px direkt aus dem bestehenden globalen Responsive-Floor oben
  in diesem Dokument übernommen — keine neue Breakpoint-Diskussion.
- Slug-Namen der Kategorien (`workspace`, `zugaenge`, `sicherung`, …) sind neu
  festgelegt (nicht vom Owner vorgegeben) — kebab-case, deutsch, stabil für
  Deep-Links.
- Automatic-activation-Tastaturmuster (Pfeiltasten aktivieren sofort, statt
  zusätzlichem Enter) gewählt, weil das Tabpanel per `tabIndex={0}` direkt
  fokussierbar ist — kürzester Weg von Kategorie-Wahl zu Inhalt, passt zum
  Admin-Tool-Charakter.
- `MiscSection` („Weitere Credentials") wird bewusst in **Diverses** statt in
  **Zugänge & Schlüssel** einsortiert, obwohl es fachlich auch Credentials
  sind — Name/Zweck („weitere", nicht integrations-gebunden) passt besser zum
  Auffangort. Falls der Owner das anders wünscht, ist dies eine
  einzeilige Änderung an der Tabelle in Abschnitt 1 (D2).
- Farbpalette bleibt bei inline-Style-Objekten (kein neues
  CSS-Custom-Properties-System) — folgt der etablierten Projekt-Konvention in
  `SettingsView.jsx` statt neu einzuführen; bewusst dokumentierte Fortführung
  der bestehenden Konvention statt einer wörtlichen `css/R01`-Neueinführung.
- Die genaue Aufteilung der Kategorie-Wrapper-Dateien (`client/src/settings/
  categories/*.jsx` vs. eine andere Verzeichnisstruktur) ist ein
  Implementierungsdetail des `coder` — bindend ist nur: eine Datei je
  Kategorie, bestehende Sektions-Komponenten unverändert wiederverwendet.
