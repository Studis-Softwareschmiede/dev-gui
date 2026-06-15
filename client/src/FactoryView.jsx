/**
 * FactoryView.jsx — Fabrik-Einstiegspunkt: projekt-zentriertes Cockpit (AC1–AC3).
 *
 * projekt-cockpit-navigation:
 *   AC1 — #/factory (kein Repo): zeigt RepoOverview der lokalen Klone.
 *   AC2 — Repo-Auswahl setzt activeRepo (State + #/factory/<repo>);
 *          Reload/Deep-Link auf #/factory/<repo> stellt das Projekt wieder her;
 *          Rückweg zur Übersicht über CockpitView-Back-Button (→ navigateFactory(null)).
 *   AC3 — Bei aktivem Projekt: CockpitView mit Reitern Arbeiten/Board/Spezifikation.
 *          Reiter erben den Projekt-Kontext (activeRepo).
 *
 * AppShell übergibt factoryRepo (aus useHashRouter) und navigateFactory:
 *   - factoryRepo === null  → Repo-Übersicht (AC1)
 *   - factoryRepo === 'xyz' → Cockpit für Projekt 'xyz' (AC3)
 *
 * A11y: WCAG 2.1 AA — erbt von RepoOverview und CockpitView.
 * Security (Floor): Keine Secrets, kein dangerouslySetInnerHTML, keine neuen Endpunkte.
 */

import { RepoOverview } from './RepoOverview.jsx';
import { CockpitView } from './CockpitView.jsx';

/**
 * @param {{
 *   onNavigate: (view: string) => void,
 *   factoryRepo?: string | null,
 *   navigateFactory?: (repo: string | null) => void,
 * }} props
 */
export function FactoryView({ onNavigate, factoryRepo = null, navigateFactory }) {
  // Fallback: wenn navigateFactory nicht übergeben wurde (z.B. in Tests),
  // nutze window.location direkt. In der App kommt es immer von AppShell.
  const navFactory = navigateFactory ?? ((repo) => {
    window.location.hash = repo ? `#/factory/${repo}` : '#/factory';
  });

  // AC1: kein Repo → Übersicht
  if (!factoryRepo) {
    return (
      <RepoOverview navigateFactory={navFactory} />
    );
  }

  // AC2+3: Repo aktiv → Cockpit mit Reitern
  return (
    <CockpitView
      activeRepo={factoryRepo}
      navigateFactory={navFactory}
      onNavigate={onNavigate}
    />
  );
}
