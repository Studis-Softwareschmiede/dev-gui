# Designer-Lessons (dev-gui, projekt-lokal)

> Eigene Design-System-/Verfahrens-Lessons. Newest-first. Nur systemische,
> wiederkehrende Muster — kein Write-back pro Lauf.

## Linke Navigation: Tablist vs. `aria-current`-Navigation bewusst trennen (2026-07-18)

Im Dark-Theme-Admin-Tool gibt es inzwischen **zwei** linke Vertikal-Navigationen
(Settings-Kategorien, Bereichs-Untermenü Deployments) — **optisch identisch**
(gleiche `#1e293b`/`#e5e7eb`/`#3b82f6`-Tokens, 220 px, 1024-px-Umklappen), aber
mit **bewusst unterschiedlicher Semantik**. Regel für künftige linke Navs:

- **Facetten EINES Inhalts** (Kategorien eines Panels, Deep-Link je Facette) →
  **Tablist**: `role="tablist"`/`tab`/`tabpanel`, `aria-selected`, Roving
  Tabindex (ein Tab-Stopp), Pfeiltasten aktivieren sofort. Vorbild:
  „Settings-Panel Navigation" in `docs/design.md`.
- **Navigation zwischen eigenständigen Unteransichten** eines Bereichs (reiner
  Client-State, Deep-Link optional) → **`<nav>`-Landmark + Buttons mit
  `aria-current="page"`**, jeder Eintrag ein **normaler Tab-Stopp** (kein
  Roving), Enter/Space aktiviert, **keine** Pfeiltasten-Logik. Vorbild:
  „Bereichs-Untermenü" in `docs/design.md`.

Falsch ist, `aria-selected`/Tablist reflexartig für jede linke Nav zu
übernehmen — die Spec fordert bei In-Bereichs-Navigation `aria-current` (nicht
`aria-selected`), und AT erwartet dort Navigations- statt Tab-Widget-Verhalten.
Beim Definieren einer neuen linken Nav **zuerst** klären: Tab-Widget oder
Navigation? Danach richtet sich Rolle **und** Tastaturmodell. CSS-Klassenfamilie
generisch benennen (`.subnav-*` statt `settings-*` wiederverwenden), damit das
Muster nicht an eine View gekoppelt ist.
