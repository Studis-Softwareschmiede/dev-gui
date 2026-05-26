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
