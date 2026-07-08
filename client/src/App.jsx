/**
 * App.jsx — Root application component.
 *
 * Renders the App-Shell (entry panel + hash-router navigation).
 * The previous single-view layout (Terminal + Status-Dashboard-Kachel;
 * TriggerPanel entfernt — cockpit-declutter AC1, S-303; Status-Dashboard-
 * Kachel entfernt — cockpit-declutter AC2, S-304) is preserved as
 * FactoryView, accessible via the 'factory' route.
 *
 * See AppShell.jsx for the full App-Shell implementation (AC1–AC7).
 */

import { AppShell } from './AppShell.jsx';

export function App() {
  return <AppShell />;
}
