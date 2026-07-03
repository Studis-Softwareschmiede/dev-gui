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
