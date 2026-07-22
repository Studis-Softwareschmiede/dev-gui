/**
 * viewRegistry.js — View-Manifest: Single source of truth for all registered views.
 *
 * AC7 (parallel-agent-workflow): Views registered via manifest/convention; each entry
 *   defines id, Component, and optional tile metadata — at ONE place per view.
 *   AppShell.jsx imports only from here; no per-view imports or switch chains there.
 * AC8: Adding a new view = new view file + new entry here; AppShell.jsx unchanged.
 * AC9: All existing routes represented: factory, github, vps, cloudflare, deployments,
 *   settings, team, retro, retro-trend, board, and the implicit 'panel' root.
 * AC10: Tile views listed in exact order (github, vps, cloudflare, factory, team,
 *   deployments); settings/retro/retro-trend have tile: null (no panel tile).
 * AC11: AppShell renders only the active view conditionally (see AppShell.jsx); all
 *   components are imported here statically but mounted only on demand.
 * AC12: No new secrets, no new backend endpoints, no view-specific authorization.
 *
 * Security (Floor):
 *   - No secrets in bundle.
 *   - No new backend endpoints.
 *   - No view-specific authorization bypass.
 */

import { FactoryView }      from './FactoryView.jsx';
import { GitHubView }       from './GitHubView.jsx';
import { VpsView }          from './VpsView.jsx';
import { CloudflareView }   from './CloudflareView.jsx';
import { DeploymentsView }  from './DeploymentsView.jsx';
import { SettingsView }     from './SettingsView.jsx';
import { TeamView }         from './TeamView.jsx';
import { RetroView }        from './RetroView.jsx';
import { RetroTrendView }   from './RetroTrendView.jsx';
import { BoardView }        from './BoardView.jsx';

/**
 * @typedef {{ label: string, description: string }} TileMeta
 *
 * @typedef {{
 *   id: string,
 *   Component: import('react').ComponentType<{ onNavigate: (view: string) => void }>,
 *   tile: TileMeta | null,
 * }} ViewEntry
 */

/**
 * VIEW_REGISTRY — ordered list of all registered views.
 *
 * Tile entries (tile !== null) appear in panel order as mandated by AC10:
 *   github → vps → cloudflare → factory → team → deployments
 * Non-tile views (settings, retro, retro-trend) follow; order there is arbitrary.
 * (red-team-tile Rückbau, S-408/AC23 red-team-scan-per-container: die eigenständige
 * Red-Team-Kachel entfällt — der Pro-Container-Scan-Knopf in VpsView.jsx ist der
 * einzige Einstieg.)
 *
 * @type {ViewEntry[]}
 */
export const VIEW_REGISTRY = [
  // ── Tile views (panel order, AC10) ──────────────────────────────────────────
  {
    id: 'github',
    Component: GitHubView,
    tile: {
      label: 'GitHub',
      description: 'Repositories, Board-Items und CI-Runs im Blick.',
    },
  },
  {
    id: 'vps',
    Component: VpsView,
    tile: {
      label: 'VPS',
      description: 'Server-Verwaltung und SSH-Provisionierung.',
    },
  },
  {
    id: 'cloudflare',
    Component: CloudflareView,
    tile: {
      label: 'Cloudflare',
      description: 'Tunnel, Access und DNS — Konfiguration auf einen Blick.',
    },
  },
  {
    id: 'factory',
    Component: FactoryView,
    tile: {
      label: 'Fabrik (dev-gui)',
      description: 'Interaktive Claude-Code-Session, Flow-Trigger und Status.',
    },
  },
  {
    id: 'team',
    Component: TeamView,
    tile: {
      label: 'Team',
      description: 'Agenten, Skills und Knowledge der Fabrik einsehen.',
    },
  },
  {
    id: 'deployments',
    Component: DeploymentsView,
    tile: {
      label: 'Deployments',
      description: 'Deployments, Container und Cloudflare-Routen im Blick.',
    },
  },

  // ── Non-tile views (route-only, AC10: not in panel grid) ────────────────────
  {
    id: 'settings',
    Component: SettingsView,
    tile: null,
  },
  {
    id: 'retro',
    Component: RetroView,
    tile: null,
  },
  {
    id: 'retro-trend',
    Component: RetroTrendView,
    tile: null,
  },
  // studis-kanban-board-ux AC1: label = "Studis-Kanban-Board"; route-only (not a panel tile)
  {
    id: 'board',
    Component: BoardView,
    tile: null,
    label: 'Studis-Kanban-Board',
  },
];

/**
 * TILE_VIEWS — ordered subset of VIEW_REGISTRY entries that appear as panel tiles (AC10).
 * GitHub → VPS → Cloudflare → Fabrik (dev-gui) → Team → Deployments.
 *
 * @type {ViewEntry[]}
 */
export const TILE_VIEWS = VIEW_REGISTRY.filter((v) => v.tile !== null);
