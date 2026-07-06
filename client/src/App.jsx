/**
 * App.jsx — Root application component.
 *
 * Renders the App-Shell (entry panel + hash-router navigation).
 * The previous single-view layout (Terminal + Dashboard; TriggerPanel entfernt
 * — cockpit-declutter AC1, S-303) is preserved as FactoryView, accessible via
 * the 'factory' route.
 *
 * See AppShell.jsx for the full App-Shell implementation (AC1–AC7).
 */

import { AppShell } from './AppShell.jsx';

export function App() {
  return <AppShell />;
}
