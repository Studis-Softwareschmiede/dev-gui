# Design-System — dev-gui

> Teil des Detailkonzepts (**UI-Domäne**). Bindend für den `coder`; Konformität (Kontrast/Spacing/A11y) prüft der `reviewer` via UI-Pack-Checklist. Detail-Ausarbeitung beim ersten Frontend-Item durch den `designer` — hier die Leitplanken.

## Tokens
- **Theme:** Dark-first (Entwickler-Konsole, viel Terminal). Hintergrund neutral-dunkel, ein Akzent (Aktion/Trigger), klare Statusfarben (grün=ready/done, amber=busy/running, rot=failed/cancelled/blocked).
- **Spacing:** 8-pt-Skala.
- **Typografie:** Monospace im Terminal-Pane; UI-Sans für Panels/Dashboard.

## Komponenten-Patterns
- **Terminal-Pane** — dominanter, scrollbarer xterm.js-Bereich; Verbindungs-Status sichtbar.
- **Audit-Ansicht** — chronologische Liste (Zeit · Identität · Befehl).

> **Trigger-Panel entfernt (cockpit-declutter AC1, S-303):** das generische
> Befehls-Trigger-Panel (Projekt/Item wählen → Aktions-Button + Kill) ist aus
> dem „Arbeiten"-Reiter entfernt. Der einzige weiterhin benötigte interaktive
> Weg (Adopt) lebt jetzt auf der Fabrik-Übersicht ([[neues-projekt-auswahl-dialog]]).

> **Status-Dashboard entfernt (cockpit-declutter AC2, S-304):** die
> Status-Dashboard-Kachel (Karten je Projekt: offene Items, letzter CI-Lauf,
> Preview-Container mit klickbarer URL) ist aus dem „Arbeiten"-Reiter
> restlos entfernt (`client/src/Dashboard.jsx` gelöscht). `GET /api/status`
> bleibt unverändert bestehen (weiterer Konsument: `ClaudeAuthBadge.jsx`).

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
   Status/Bericht), „Idee" und „Neue Story" — werden
   statt in einer vertikalen Einzelspalte als **umbrechendes Karten-Grid**
   (`flex-wrap`, 8-pt-Abstand; „Board abarbeiten"/„Idee"/„Neue Story" mit
   vollem Rahmen statt nur Unterlinie) nebeneinander angeordnet. Hierarchie: „Board abarbeiten" bleibt die erste/
   prominenteste Karte (Primäraktion), die übrigen folgen in bestehender
   Reihenfolge. Funktion/Verhalten jedes Buttons bleibt unverändert (gleiche
   Handler/Endpunkte) — nur Anordnung/Optik ändern sich. (Trigger-Panel
   entfernt, cockpit-declutter AC1, S-303; Status-Dashboard-Kachel entfernt,
   cockpit-declutter AC2, S-304.)
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

## Fabrik-Panel Regressionstests (fabrik-panel-regressionstests, Owner-Ko-Design 2026-07-03, beauftragt 2026-07-06)

Designer-Vorgabe für einen neuen, eigenständigen Bereich „Regressionstests" im
Fabrik-„Arbeiten"-Reiter (`CockpitView.jsx`, `actionGrid` im
`FactoryWorkspace`-Bereich, s. Abschnitt „„Arbeiten"-Layout" oben). Genau zwei
Buttons untereinander: „Regressionstest ausführen" (primär) und
„Regressionstest definieren" (sekundär). Konsistent zum bestehenden
Kartenmuster der Nachbarkarten „Board abarbeiten" / „Idee" / „Neue Story" —
**keine neuen Farbwerte**, ausschließlich bereits im Repo verwendete Tokens
(`flowTriggerBox`/`intakeTriggerBox`, `btnFlowTrigger`/`btnFlowTriggerDisabled`,
`btnCancel`-Outline-Familie, `drainStatusDone`/`drainStatusFailed`/
`drainStatusRunning`, `lockNotice`). Bindend für `coder`/`requirement`;
Konformität prüft `reviewer`.

### 1. Platzierung

Neue Karte **„Regressionstests"** im `actionGrid` des Arbeiten-Reiters, direkt
**nach** der „Neue Story"-Karte (TriggerPanel
ist entfernt, cockpit-declutter AC1, S-303; die zu diesem Zeitpunkt noch
bestehende Status-Dashboard-Kachel danach ist seither ebenfalls entfernt,
cockpit-declutter AC2, S-304) —
sie gehört fachlich zur Gruppe der einfachen Aktions-Karten (Titel + Button(s))
statt zur Gruppe der komplexeren, breiteren Panels. Resultierende Grid-Reihenfolge:

1. Board abarbeiten
2. Idee
3. Neue Story
4. **Regressionstests** *(neu)*

Das Grid selbst (`display:flex; flexWrap:wrap; gap:16; padding:16`) ist
unverändert — die neue Karte reiht sich als fünftes Flex-Item ein und
umbricht unter ~768 px identisch zu den bestehenden Karten (s. „„Arbeiten"-
Layout" oben, keine neue Breakpoint-Logik).

### 2. Kartengestaltung

**Kartenrahmen** — identisch zum bestehenden `flowTriggerBox`/
`intakeTriggerBox`-Token, keine neue Variante:
- `padding: '12px 16px'`, `background: '#0d0d0d'`, `border: '1px solid
  #2a2a2a'`, `borderRadius: 6`, `minWidth: 240`, `maxWidth: 300`,
  `display:'flex'`, `flexDirection:'column'`, `gap: 8`.

**Kartenkopf** — Titel „Regressionstests" im bestehenden
`flowTriggerHeader`-Stil (identisch zu den Nachbarkarten, kein neuer
Header-Stil): `fontSize:12`, `fontWeight:700`, `color:'#9ca3af'`,
`textTransform:'uppercase'`, `letterSpacing:'0.05em'`.

**Kurzbeschreibung** — ein Satz im bestehenden `flowTriggerHint`-Stil
(`fontSize:11`, `color:'#6b7280'`) direkt unter dem Titel, z.B. „Führt die
hinterlegte Regressionstest-Suite aus bzw. öffnet ihre Definition."

**Zwei Buttons UNTEREINANDER**, `gap: 8` (identischer Innenabstand wie der
restliche Karten-Inhalt), volle Kartenbreite je Button, feste Reihenfolge
(oben → unten):

1. **„Regressionstest ausführen" — PRIMÄR.** Reuse `btnFlowTrigger`-Token
   1:1: `background:'#1d4ed8'`, `color:'#fff'`, `border:'none'`,
   `borderRadius:4`, `padding:'8px 12px'`, `fontSize:13`, `fontWeight:600`,
   `minHeight:44`, `cursor:'pointer'`. Gesperrt-Zustand (Lauf bereits aktiv):
   reuse `btnFlowTriggerDisabled` 1:1 (`background:'#1e293b'`,
   `color:'#64748b'`, sonst identisch).
2. **„Regressionstest definieren" — SEKUNDÄR.** Reuse die bestehende
   Outline-Sekundär-Familie (`btnCancel`/`btnFlowReset`): `background:
   'transparent'` (zeigt den Kartenhintergrund `#0d0d0d` durch),
   `border:'1px solid #374151'`, `color:'#9ca3af'`, `borderRadius:4`,
   `padding:'8px 12px'` (an die Primär-Button-Höhe/-Breite angeglichen, nicht
   die kompaktere `6px 10px`-Variante aus dem Confirm-Dialog-Button-Paar, da
   hier ein Standalone-Button statt ein Dialog-Button-Paar), `fontSize:13`,
   `fontWeight:400` (bewusst **nicht** fett), `minHeight:44`,
   `cursor:'pointer'`.

**Visuelle Hierarchie (Empfehlung):** Primär = gefüllte Fläche (`#1d4ed8`) +
Fettdruck (600); Sekundär = Outline (transparent + `#374151`-Rahmen) +
Normalgewicht (400). Dieses Unterscheidungsmuster ist im Projekt bereits
etabliert (`btnConfirm` gefüllt vs. `btnCancel` outline im
Bestätigungsdialog; Aktiv/Inaktiv-Unterscheidung in der Settings-Navigation
oben, D6/D7) — keine neue Konvention, reine Wiederanwendung.

### 3. Zustände (Kurz-Status inline)

Direkt unterhalb der beiden Buttons, analog zum bestehenden
Drain-Abschlussbericht-Muster (`drainStatusDone`/`drainStatusFailed`/
`drainStatusRunning`, headless-manual-drain AC6 + drain-completion-report
AC7a — s. `CockpitView.jsx`):

| Zustand | Text | Stil (Token) | Rolle |
|---|---|---|---|
| Noch kein Lauf | „Noch kein Regressionstest gelaufen." | `flowTriggerHint` (`fontSize:11`, `color:'#6b7280'`) | reiner Hinweistext, kein `role` |
| Läuft | „⏳ Regressionstest läuft…" | `drainStatusRunning` (`fontSize:12`, `color:'#9ca3af'`, `fontStyle:'italic'`) | `role="status" aria-live="polite"` |
| Letzter Lauf erfolgreich | „✓ Erfolgreich — `<Zeitstempel>`" | `drainStatusDone` (`fontSize:12`, `color:'#86efac'`, `fontWeight:600`) | `role="status" aria-live="polite"` |
| Letzter Lauf fehlgeschlagen | „✗ Fehlgeschlagen — `<Zeitstempel>`" | `drainStatusFailed` (`fontSize:12`, `color:'#f87171'`, `fontWeight:600`) | `role="alert"` |

- **Zeitstempel-Format:** `new Date(ts).toLocaleString('de-DE', {
  dateStyle: 'short', timeStyle: 'medium' })` — identisch zum bestehenden
  Muster in `BackupSection.jsx` (kein neues Datumsformat).
- **Icon + Text + Farbe immer zusammen** (nie Farbe allein) — WCAG 2.1 AA,
  identisch zur bestehenden Board-abarbeiten-Statuszeile.
- Während eines aktiven Regressionstest-Laufs ist **nur** „Regressionstest
  ausführen" gesperrt (verhindert Doppel-Trigger); „Regressionstest
  definieren" bleibt bedienbar — Definieren steht in keinem Konflikt zu einem
  laufenden Testlauf. Der Sperr-Hinweistext reuse `lockNotice` 1:1
  (`fontSize:11`, `color:'#fbbf24'`, `fontStyle:'italic'`), Wortlaut „Ein
  Regressionstest läuft — Ausführen gesperrt."

### 4. Accessibility (WCAG 2.1 AA)

- **Touch-Targets:** beide Buttons `minHeight:44` bei voller Kartenbreite
  (kein horizontaler Engpass) — erfüllt ≥ 44 px in beiden Dimensionen.
- **aria-labels:**
  - Primär: `aria-label="Regressionstest ausführen — startet die
    Regressionstest-Suite"`; gesperrt: `aria-label="Regressionstest
    ausführen — gesperrt (Lauf aktiv)"` (analog zum bestehenden
    „Board abarbeiten — gesperrt"-Muster).
  - Sekundär: `aria-label="Regressionstest definieren — öffnet die
    Definitionsansicht"`.
- **Tastaturbedienbarkeit:** beide als natives `<button type="button">`
  (fokussierbar/aktivierbar per Tab + Enter/Space), Fokusring **nicht**
  entfernt (kein `outline:none`, wie alle bestehenden Buttons im Panel).
  Tab-Reihenfolge = DOM-Reihenfolge = visuelle Reihenfolge (ausführen vor
  definieren).
- **Kontrast** (keine neuen Werte — bereits im Repo an anderer Stelle in
  exakt dieser Bedeutung im Einsatz und dort geprüft):
  - `#fff` auf `#1d4ed8` (Primär-Button) ≈ 6.7:1.
  - `#9ca3af` auf `#0d0d0d` (Sekundär-Button-Text, Kartenhintergrund) ≈
    7.7:1.
  - `#86efac` / `#f87171` / `#9ca3af` auf `#0d0d0d` (Statuszeilen) — bereits
    an anderer Stelle im selben Panel als ≥ 4.5:1 dokumentiert (s.
    `noLiveHint`/`drainReportBox`-Kommentare in `CockpitView.jsx`).
  - Alle Werte ≥ 4.5:1 für Text bzw. ≥ 3:1 für den blauen Fokusring
    (`#3b82f6`, projektweiter Fokus-Token).
- **Statusfarbe nie alleinige Bedeutung:** jeder Zustand trägt Icon + Text
  zusätzlich zur Farbe (s. Tabelle oben).

### 5. Design-Entscheidungen (testbar)

- **D1** — Neue Karte „Regressionstests" im `actionGrid`, Position: nach
  „Neue Story" (Reihenfolge: Board
  abarbeiten, Idee, Neue Story, Regressionstests;
  TriggerPanel entfernt, cockpit-declutter AC1, S-303; Status-Dashboard-
  Kachel entfernt, cockpit-declutter AC2, S-304).
- **D2** — Kartenrahmen identisch zum bestehenden `flowTriggerBox`/
  `intakeTriggerBox`-Token (`padding:'12px 16px'`, `background:'#0d0d0d'`,
  `border:'1px solid #2a2a2a'`, `borderRadius:6`, `minWidth:240`,
  `maxWidth:300`, `gap:8`) — keine neue Kartenvariante.
- **D3** — Kartenkopf „Regressionstests" im bestehenden
  `flowTriggerHeader`-Stil (uppercase, 12px, 700, `#9ca3af`, letterSpacing
  0.05em), identisch zu den Nachbarkarten.
- **D4** — Kurzbeschreibung im bestehenden `flowTriggerHint`-Stil (11px,
  `#6b7280`) direkt unter dem Titel.
- **D5** — Genau zwei Buttons untereinander, `gap:8`, volle Kartenbreite je
  Button, feste Reihenfolge: 1) „Regressionstest ausführen", 2)
  „Regressionstest definieren".
- **D6** — Primär-Button „Regressionstest ausführen": exakt
  `btnFlowTrigger`-Token (`#1d4ed8`/`#fff`/`borderRadius:4`/`padding:'8px
  12px'`/`fontSize:13`/`fontWeight:600`/`minHeight:44`). Gesperrt-Zustand:
  exakt `btnFlowTriggerDisabled`-Token (`#1e293b`/`#64748b`).
- **D7** — Sekundär-Button „Regressionstest definieren": Outline-Stil
  (`background:'transparent'`, `border:'1px solid #374151'`,
  `color:'#9ca3af'`, `borderRadius:4`, `padding:'8px 12px'`, `fontSize:13`,
  `fontWeight:400`, `minHeight:44`) — reuse der bestehenden
  `btnCancel`/`btnFlowReset`-Familie, keine neue Farbe.
- **D8** — Visuelle Hierarchie ausschließlich über Fläche (gefüllt vs.
  Outline) + Fettdruck (600 vs. 400), nicht über eine neue Farbe — reuse des
  bereits etablierten `btnConfirm`/`btnCancel`-Unterscheidungsmusters.
- **D9** — Status-Zustände inline unterhalb der Buttons: „kein Lauf" /
  „läuft" / „erfolgreich + Zeitstempel" / „fehlgeschlagen + Zeitstempel",
  Stile 1:1 aus `drainStatusRunning`/`drainStatusDone`/`drainStatusFailed`
  übernommen; `role="status"` außer bei fehlgeschlagen (`role="alert"`).
- **D9a** (S-326, Ergänzung zu D9) — **Fünfter Zustand „nicht ausgeführt"**:
  „⚠ Nicht ausgeführt — `<Zeitstempel>`" für einen Lauf, der vor der
  Testausführung scheiterte (`status: "precondition-error"|"error"`,
  s. [[regression-result-store]] AC1b). Bewusst ein **eigener** Zustand,
  nicht „fehlgeschlagen": rot behauptet eine gemessene Test-Regression, die
  nie stattfand — und „kein Lauf" (das bisherige, faktische Verhalten)
  verschweigt den Fehler ganz. Stil = `drainStatusFailed`-Token mit
  `color:'#fbbf24'` (Amber, in D15 bereits gelistet — **kein** neuer
  Farbwert); Icon „⚠" als Unicode-Zeichen wie „⏳"/„✓"/„✗"; `role="alert"`
  (der Owner muss handeln). Der Fehlgrund (`reason`) selbst gehört **nicht**
  in die einzeilige Karte, sondern in die Ergebnis-Ansicht
  ([[regression-result-view]] AC7) — die Karte verlinkt ihn nicht (die
  „Ergebnisse ansehen"-Karte daneben ist der Einstieg).
- **D10** — Zeitstempel-Format `toLocaleString('de-DE', {dateStyle:'short',
  timeStyle:'medium'})`, identisch zu `BackupSection.jsx`.
- **D11** — Während eines aktiven Laufs ist ausschließlich der
  „ausführen"-Button gesperrt (`aria-disabled` + D6-Disabled-Token +
  `lockNotice`-Hinweistext „Ein Regressionstest läuft — Ausführen
  gesperrt."); „definieren" bleibt bedienbar.
- **D12** — Touch-Targets: beide Buttons `minHeight:44`, volle
  Kartenbreite.
- **D13** — aria-labels wie in Abschnitt 4 spezifiziert (inkl.
  Gesperrt-Variante am Primär-Button).
- **D14** — Beide Buttons `<button type="button">`, kein `outline:none`,
  Tab-Reihenfolge = visuelle Reihenfolge.
- **D15** — Keine neuen Farbwerte: alle verwendeten Hex-Werte (`#0d0d0d`,
  `#2a2a2a`, `#9ca3af`, `#6b7280`, `#1d4ed8`, `#fff`, `#1e293b`, `#64748b`,
  `#374151`, `#86efac`, `#f87171`, `#fbbf24`) sind im Repo bereits an anderer
  Stelle in exakt dieser Bedeutung im Einsatz (`CockpitView.jsx`).
- **D16** — `data-testid`-Konvention (kebab-case, Präfix `regression-`):
  `regression-card`, `regression-run-btn`, `regression-define-btn`,
  `regression-status`. Der Zustand steht zusätzlich in `data-status`
  (`running`/`passed`/`failed`/`not-run`/`none`, S-326).

### Annahmen

- Kein Board-Story-Bezug (S-Nummer) für diese Design-Erweiterung bekannt —
  Abschnitt referenziert das Ko-Design-Datum (2026-07-03) und das
  Beauftragungsdatum (2026-07-06) des Owners.
- Das genaue Ziel des „Regressionstest definieren"-Klicks (eigenständige
  View, Modal/Overlay analog `IdeaCaptureModal`, oder Navigation in einen
  Editor) ist eine Architektur-/Implementierungsentscheidung außerhalb des
  Design-Scopes — bindend ist hier nur die visuelle Sekundär-Affordance
  (Outline-Button), nicht das konkrete Ziel-Artefakt.
- Die genaue Quelle/Trigger-Mechanik der Statuszeile (Polling wie beim
  Drain-Job-Status, WebSocket-Push, oder rein lokaler State) ist ebenfalls
  Architektur-/Implementierungssache — bindend ist nur die visuelle
  Zustandsdarstellung (Tabelle in Abschnitt 3) und dass „läuft" nur den
  „ausführen"-Button sperrt (D11).
- Angenommen: „Regressionstest ausführen" und „Board abarbeiten" laufen in
  **getrennten** Concurrency-Domänen (kein automatisches gegenseitiges
  Sperren) — folgt der etablierten Linie, dass jede Aktions-Karte ihren
  eigenen Lock-Zustand zeigt (s. bestehende Karten); falls der `architekt`
  eine gemeinsame Sperre für nötig hält, ist das eine additive Ergänzung zu
  D11, kein Widerspruch.
- Kein neuer Icon-Font/keine neue Icon-Bibliothek — „⏳"/„✓"/„✗" als
  Unicode-Zeichen, identisch zur bestehenden Praxis in `CockpitView.jsx`
  (`drainStatus`-Texte).

## Feature-Umsetzen-Button (3 Zustände) (feature-umsetzen-button, Owner-Auftrag 2026-07-06)

Designer-Vorgabe für einen neuen Tri-State-Button/Badge auf **jeder
Feature-Karte** im Studis-Kanban-Board (`BoardView.jsx`, `FeatureRow`) — löst
ein neues Feature-Batch-Skript aus (verarbeitet alle Storys des Features
nacheinander, merged + deployt am Ende gebündelt einmal). Die drei
Zustände (Text, Farbe, Klickbarkeit) sind vom Owner **explizit und
verbindlich** festgelegt — inkl. der bewussten Abweichung von der üblichen
Ampel-Konvention (Rot = „Fertig/Erfolg" statt „Fehler"). Bindend für
`coder`; Konformität prüft `reviewer`. **Keine neuen Farbwerte** — alle drei
Zustände reusen 1:1 bereits im Repo etablierte, filled Button-Tokens
(`btnConfirm`/CockpitView.jsx, `archiveConfirmBtn`/BoardView.jsx,
`btnOverwriteConfirm`/SshKeysSection.jsx).

### 1. Platzierung

In `styles.featureHeader` (flex-row, `flexWrap:wrap`, `alignItems:center`,
`gap:8`), zwischen dem Feature-Status-Badge (`StatusBadge`) und der
`RollupBar` — Reihenfolge im Header:

1. Collapse-Button (Titel, `flex:1`)
2. `StatusBadge` (Feature-Status, falls vorhanden)
3. „Archiviert"-Badge (falls `isArchivedFeature`)
4. **Umsetzen-Button (neu)**
5. `RollupBar`
6. Detail-Schalter (ⓘ)

Beide Status-Indikatoren (Feature-Status-Badge + neuer Tri-State-Button)
bilden so einen zusammenhängenden Block, bevor die Fortschrittsanzeige folgt.

**Nicht gerendert, wenn:**
- `isArchivedFeature === true` — archivierte Features sind read-only, keine
  Aktions-Affordance (bestehende Regel, board-feature-archive AC6/AC7).
- Das Feature hat **0 Storys** (`rollup.total === 0`) — keiner der drei
  Zustände ist sinnvoll definiert (kein „Fertig" bei 0 Storys, kein
  „Bereit" ohne Arbeit). Kein Button, keine Badge-Attrappe.

### 2. Die drei Zustände (Owner-Vorgabe, unverändert)

| # | Bedingung | Text | Farbe (Hintergrund/Text) | Reused Token (Quelle) | Klickbar |
|---|---|---|---|---|---|
| 1 | Feature hat mind. eine nicht-terminale Story (Status ∉ {Done, Verworfen}) UND kein Batch-Lauf aktiv | **„Umsetzen"** | `#15803d` / `#fff` | `btnConfirm` (`CockpitView.jsx`) | Ja |
| 2 | Ein Feature-Batch-Lauf verarbeitet aktuell Storys dieses Features | **„In Progress"** | `#b45309` / `#fff` | `archiveConfirmBtn` (`BoardView.jsx`) | Nein |
| 3 | Alle Storys terminal (Done/Verworfen) UND finaler Merge+Deploy durch | **„Done"** | `#7f1d1d` / `#fecaca` | `btnOverwriteConfirm` (`SshKeysSection.jsx`) | Nein |

**Kontrast (berechnet, WCAG 2.1 AA, ≥ 4.5:1 für Text):**
- `#fff` auf `#15803d` ≈ **5.0:1** (relative Luminanz Hintergrund ≈ 0.159).
- `#fff` auf `#b45309` ≈ **5.0:1** (relative Luminanz Hintergrund ≈ 0.159,
  nahezu identisch zu Zustand 1 — Zufall der beiden Referenzfarben, kein
  Bug).
- `#fecaca` auf `#7f1d1d` ≈ **6.9:1** (relative Luminanz Hintergrund ≈
  0.055, Text ≈ 0.676).
- Alle drei ≥ 4.5:1 — konform, keine Ausnahme für „große Schrift" nötig.

**Icon + Text + Farbe (nie Farbe allein)** — Bedeutung trägt bereits der
Text als zweiter Kanal (Owner-Feststellung); zusätzlich ein `aria-hidden`
Unicode-Icon vor dem Text, identisch zur etablierten Praxis
(„Fabrik-Panel Regressionstests" oben, `drainStatus`-Texte in
`CockpitView.jsx`):
- Zustand 1: `▶ Umsetzen`
- Zustand 2: `⏳ In Progress`
- Zustand 3: `✓ Done`

### 3. Zustands-Ableitung (Datenquelle — Grenze zur Architektur)

Bindend ist NUR: genau **ein** autoritativer Zustandswert je Feature
(`ready` | `running` | `done`), niemals unabhängig berechnete Booleans (kein
`isRunning && isDone` gleichzeitig möglich — Vermeidung von
Zustands-Kombinationsfehlern). Die konkrete Datenquelle (neues Backend-Feld,
z. B. `feature.batchState`, Polling vs. SSE-Push) ist Architektur-/
Coder-Entscheidung, **außerhalb** des Design-Scopes — s. Annahmen.

**Wichtig — ungefilterter Story-Bestand:** Die Zustandsableitung MUSS auf dem
**vollständigen** Story-Bestand des Features basieren, nicht auf der im
Board ggf. gefilterten Teilmenge (`feature.stories`-Prop in `FeatureRow` ist
laut bestehendem Kommentar bereits die GEFILTERTE Menge). Ein Klick auf
„Umsetzen" verarbeitet ALLE Storys des Features, unabhängig vom aktuell
aktiven Board-Filter — die Sichtbarkeits-Filterung (board-filter-
feature-status-consistency AC1, gilt für den `StatusBadge`) und die
Aktions-Zustandsableitung (dieser Abschnitt) sind bewusst **unterschiedliche
Datenquellen**, keine Regression von AC1.

### 4. Bestätigungsdialog vor „Umsetzen"

Analog zum bestehenden „Board abarbeiten"-Muster (`CockpitView.jsx`,
`flowState === 'confirm'`) — ein Klick auf „Umsetzen" (Zustand 1) öffnet
zuerst einen Bestätigungsdialog (`role="dialog" aria-modal="false"`,
reuse `confirmBox`/`btnConfirm`/`btnCancel`-Token 1:1), Text z. B.: „Startet
die Batch-Verarbeitung aller Storys dieses Features: ein Agent schreibt
Code, mergt am Ende gebündelt und deployt einmal. Fortfahren?" Erst nach
Bestätigen wird der Batch-Trigger abgesetzt. Kein neuer Dialog-Stil — reine
Wiederverwendung des etablierten Bestätigungsmusters.

Nach Bestätigen wechselt der Button **sofort optimistisch** auf Zustand 2
(„In Progress", gesperrt) — verhindert Doppel-Trigger während der
Server-Antwort aussteht; der autoritative Zustand (Abschnitt 3) überschreibt
das optimistische Bild, sobald er eintrifft (SSE/Re-Fetch, s. Abschnitt 5).

### 5. Übergangsverhalten

- Zustandswechsel (Farbe + Text + Icon) mit sanftem CSS-`transition:
  'background-color 150ms ease, color 150ms ease'` — kein hartes Umspringen.
- Gleiche Button-Abmessungen (Padding, `minHeight:44`) in allen drei
  Zuständen — kein Layout-Sprung beim Wechsel.
- Datenquelle für automatische Wechsel: reuse des bestehenden
  `board-live-sse`-Kanals (EventSource, AC13–AC17 oben in dieser Datei) —
  ein Server-Event für das angezeigte Projekt löst den bestehenden
  Re-Fetch-Pfad aus, der Button zeigt danach den neuen Zustand. Reicht die
  SSE-Granularität nicht (z. B. kein Event bei reinem Zustandswechsel ohne
  Datenänderung), ist ein zusätzlicher Poll-Mechanismus eine additive
  Architektur-Entscheidung, kein Widerspruch zu dieser Vorgabe.
- Kein eigenes Hover-Styling — konsistent mit ALLEN bestehenden gefüllten
  Buttons in diesem Repo (`btnConfirm`, `btnFlowTrigger`,
  `archiveConfirmBtn`, `btnOverwriteConfirm`: keiner definiert `:hover`,
  reiner nativer Browser-Standard). `cursor:'pointer'` nur in Zustand 1.

### 6. Accessibility (WCAG 2.1 AA)

- **Live-Region:** Der Button ist von einem Wrapper `<div role="status"
  aria-live="polite" aria-atomic="true">` umschlossen — NICHT `role="status"`
  direkt am `<button>` (würde dessen Button-Semantik für AT überschreiben).
  Der sichtbare Text-Wechsel („Umsetzen" → „In Progress" → „Done") innerhalb
  des Wrappers löst die Ansage aus — automatischer Wechsel ohne
  Nutzer-Interaktion wird so vorgelesen (Owner-Anforderung).
- **Kein doppeltes „alert":** `aria-live="polite"` in allen drei Zuständen
  (kein Fehlerfall, kein `role="alert"` nötig — Zustand 3 „Done" ist Erfolg,
  keine Störung).
- **Disabled-Semantik (Zustand 2 + 3):** natives `disabled`-Attribut +
  `aria-disabled={true}` (redundant, aber konsistent mit dem bestehenden
  „Board abarbeiten"-Lock-Muster, `isBoardBtnDisabled` in `CockpitView.jsx`),
  `cursor:'not-allowed'`. Kein `outline:none` (Fokusring bleibt sichtbar,
  auch wenn der Button aktuell nicht aktivierbar ist).
- **aria-label je Zustand** (screenreader-eindeutig, Feature-Titel
  eingebettet):
  - Zustand 1: `Feature „<Titel>" umsetzen — verarbeitet alle Storys
    nacheinander`
  - Zustand 2: `Feature „<Titel>" — Umsetzung läuft`
  - Zustand 3: `Feature „<Titel>" — abgeschlossen (Done)`
- **Touch-Target:** `minHeight:44` in allen drei Zuständen (auch
  disabled — verhindert Layout-Sprung, hält die Fläche für einen späteren
  Zustandswechsel bereit).
- **Tastatur:** natives `<button type="button">`, Tab-Reihenfolge = DOM-
  Reihenfolge (nach Feature-Status-Badge, vor RollupBar). Disabled-Buttons
  werden von nativer Tab-Navigation übersprungen (Standardverhalten) — kein
  zusätzlicher Handling-Bedarf.
- **Nie Farbe allein:** Text + Icon + Farbe immer zusammen (Abschnitt 2).

### 7. Design-Entscheidungen (testbar)

- **D1** — Platzierung im `featureHeader`: nach `StatusBadge`/„Archiviert"-
  Badge, vor `RollupBar`.
- **D2** — Kein Button, wenn `isArchivedFeature === true` ODER
  `rollup.total === 0` (keiner der drei Zustände zutreffend).
- **D3** — Zustand 1 „Bereit": Text „▶ Umsetzen", `background:'#15803d'`,
  `color:'#fff'` (reuse `btnConfirm`-Token), klickbar, öffnet
  Bestätigungsdialog.
- **D4** — Zustand 2 „Läuft": Text „⏳ In Progress", `background:'#b45309'`,
  `color:'#fff'` (reuse `archiveConfirmBtn`-Token), `disabled` + `aria-
  disabled`, `cursor:'not-allowed'`.
- **D5** — Zustand 3 „Fertig": Text „✓ Done", `background:'#7f1d1d'`,
  `color:'#fecaca'` (reuse `btnOverwriteConfirm`-Token), `disabled` +
  `aria-disabled`.
- **D6** — Kontrastwerte (berechnet): `#fff`/`#15803d` ≈ 5.0:1,
  `#fff`/`#b45309` ≈ 5.0:1, `#fecaca`/`#7f1d1d` ≈ 6.9:1 — alle ≥ 4.5:1.
- **D7** — Genau EIN autoritativer Zustandswert je Feature (`ready`|
  `running`|`done`) treibt Text/Farbe/Klickbarkeit — keine unabhängig
  berechneten, potenziell widersprüchlichen Booleans.
- **D8** — Zustandsableitung nutzt den UNGEFILTERTEN Story-Bestand des
  Features, nicht die im Board aktuell gefilterte Teilmenge.
- **D9** — Klick in Zustand 1 öffnet zuerst einen Bestätigungsdialog (reuse
  `confirmBox`/`btnConfirm`/`btnCancel`-Token 1:1, analog „Board
  abarbeiten"); erst nach Bestätigen wird der Batch-Trigger abgesetzt.
- **D10** — Nach Bestätigen wechselt der Button sofort optimistisch auf
  Zustand 2, bis der autoritative Zustand eintrifft.
- **D11** — `transition:'background-color 150ms ease, color 150ms ease'`;
  identische Abmessungen (`minHeight:44`, gleiches Padding) in allen drei
  Zuständen — kein Layout-Sprung.
- **D12** — Kein eigenes `:hover`-Styling (konsistent mit allen bestehenden
  gefüllten Buttons im Repo).
- **D13** — Live-Region: Wrapper `<div role="status" aria-live="polite"
  aria-atomic="true">` um den `<button>` — nicht `role="status"` direkt am
  Button.
- **D14** — `aria-live="polite"` in allen drei Zuständen (kein
  `role="alert"`).
- **D15** — Zustand 2/3: natives `disabled` + `aria-disabled={true}` +
  `cursor:'not-allowed'`, kein `outline:none`.
- **D16** — `aria-label` je Zustand wie in Abschnitt 6 spezifiziert (inkl.
  Feature-Titel).
- **D17** — Touch-Target `minHeight:44` in allen drei Zuständen.
- **D18** — Icon (aria-hidden) + Text + Farbe je Zustand: `▶`/`⏳`/`✓` vor
  dem jeweiligen Text.
- **D19** — Keine neuen Farbwerte: alle drei Hex-Paare (`#15803d`/`#fff`,
  `#b45309`/`#fff`, `#7f1d1d`/`#fecaca`) sind im Repo bereits an anderer
  Stelle als gefüllte Buttons im Einsatz (`btnConfirm`, `archiveConfirmBtn`,
  `btnOverwriteConfirm`).
- **D20** — `data-testid`-Konvention: `feature-umsetzen-btn-<featureId>`
  (Button), `feature-umsetzen-status-<featureId>` (Live-Region-Wrapper).

### Annahmen

- Die exakte Datenquelle des autoritativen Zustandswerts (neues Backend-Feld
  am Feature, Polling vs. SSE-Push, Name/Schema des neuen
  Feature-Batch-Endpunkts) ist eine Architektur-/Coder-Entscheidung außerhalb
  des Design-Scopes — bindend ist nur der EINE Zustandswert (D7) und die
  Ungefiltert-Regel (D8).
- Bestätigungsdialog vor dem Trigger (Abschnitt 4/D9) ist eine
  Designer-Ergänzung, vom Owner nicht explizit gefordert, aber konsistent
  mit dem bestehenden „Board abarbeiten"-Muster für folgenreiche
  Mehr-Storys-Batch-Aktionen (Code-Änderung + Merge + Deploy). Falls der
  Owner das für „Umsetzen" nicht wünscht, ist der Wegfall von D9/D10 eine
  isolierte, additive Änderung ohne Auswirkung auf D1–D8/D11–D20.
  (Zusammen-erarbeiten-Doktrin: falls Ko-Design-Signale zu dieser
  Ergänzung kommen, vor Umsetzung mit dem Owner klären.)
- Owners „nicht klickbar (oder Klick zeigt nur Status)" für Zustand 2 wurde
  als **natives `disabled`** entschieden (nicht „Klick zeigt Status-Tooltip"
  bei weiterhin aktivem Button) — einfachere, mit dem bestehenden
  „Board abarbeiten"-Lock-Muster konsistente Variante.
- Feature ohne Storys (`rollup.total === 0`) zeigt keinen der drei Zustände
  (D2) — vom Owner nicht spezifizierter Randfall, analog zur bestehenden
  Praxis, dass leere Features keine falschen Status-Signale erhalten.
- Icon-Ergänzung (`▶`/`⏳`/`✓`, D18) ist eine Verstärkung des ohnehin bereits
  vorhandenen Text-Kanals (Owner-Feststellung „Text ist ja schon da als
  zweiter Kanal") — keine Owner-Vorgabe, aber konsistent mit dem etablierten
  Icon+Text+Farbe-Muster der „Fabrik-Panel Regressionstests"-Sektion oben.
- Kein Board-Story-Bezug (S-Nummer) bekannt — Abschnitt referenziert das
  Owner-Auftragsdatum (2026-07-06).
