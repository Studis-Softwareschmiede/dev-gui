/**
 * AppShell.jsx — App-Shell: Einstiegs-Panel + client-seitige Navigation.
 *
 * AC1 — Einstiegs-Panel mit genau vier Kacheln (GitHub, VPS, Cloudflare, Fabrik (dev-gui)).
 *        Jede Kachel per Maus und Tastatur (Tab + Enter/Space) aktivierbar.
 * AC2 — Kachel "Fabrik (dev-gui)" öffnet die Fabrik-Ansicht (kein Funktionsverlust).
 * AC3 — Kacheln GitHub/VPS/Cloudflare öffnen Platzhalter-Views (kein Backend-Aufruf).
 * AC4 — Persistente NavBar aus jeder Ansicht; Home-Link zurück zum Panel.
 * AC5 — Deep-linkbare Routen via Hash (#/factory, #/github, #/vps, #/cloudflare).
 *        Wurzel-Route #/ zeigt das Einstiegs-Panel.
 * AC6 — Browser-Zurück/Vor navigiert entlang des Verlaufs; unbekannte Route → Panel.
 * AC7 — Keine neuen Secrets; keine view-spezifische Autorisierung.
 *
 * A11y: WCAG 2.1 AA — sichtbarer Fokus, aria-current auf aktiver Nav-Position,
 *        Touch-Targets ≥ 44 px, Bedeutung nicht allein über Farbe.
 *
 * Routing: useHashRouter (leichtgewichtig, keine externe Bibliothek).
 *
 * Security (Floor):
 *   - Keine Secrets im Frontend-Bundle.
 *   - Keine Umgehung der Access-Mauer (Access-Guard ist Backend-Middleware).
 *   - Keine neuen Backend-Endpunkte in diesem Paket.
 */

import { useHashRouter } from './useHashRouter.js';
import { FactoryView } from './FactoryView.jsx';
import { GitHubView } from './GitHubView.jsx';
import { VpsView } from './VpsView.jsx';
import { CloudflareView } from './CloudflareView.jsx';

// ── Entry-Panel tile definitions ──────────────────────────────────────────────

/** @type {Array<{ id: string, label: string, description: string }>} */
const TILES = [
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repositories, Board-Items und CI-Runs im Blick.',
  },
  {
    id: 'vps',
    label: 'VPS',
    description: 'Server-Verwaltung und SSH-Provisionierung.',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    description: 'Tunnel, Access und DNS — Konfiguration auf einen Blick.',
  },
  {
    id: 'factory',
    label: 'Fabrik (dev-gui)',
    description: 'Interaktive Claude-Code-Session, Flow-Trigger und Status.',
  },
];

// ── NavBar ────────────────────────────────────────────────────────────────────

/**
 * Persistent navigation bar shown on all views (not the panel itself).
 *
 * @param {{ currentView: string, onNavigate: (view: string) => void }} props
 */
function NavBar({ currentView, onNavigate }) {
  return (
    <nav style={styles.nav} aria-label="Haupt-Navigation">
      {/* Home / Zurück zum Panel (AC4) */}
      <a
        href="#/"
        style={styles.navHome}
        aria-label="Zurück zum Einstiegs-Panel"
        aria-current={currentView === 'panel' ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          onNavigate('panel');
        }}
      >
        ⌂ Panel
      </a>

      {/* Per-view nav links */}
      {TILES.map(({ id, label }) => (
        <a
          key={id}
          href={`#/${id}`}
          style={{
            ...styles.navLink,
            ...(currentView === id ? styles.navLinkActive : {}),
          }}
          aria-current={currentView === id ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            onNavigate(id);
          }}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

// ── Entry Panel ───────────────────────────────────────────────────────────────

/**
 * EntryPanel — the landing/home screen with four tiles (AC1).
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */
function EntryPanel({ onNavigate }) {
  return (
    <main style={styles.panelOuter} aria-label="Einstiegs-Panel">
      <h1 style={styles.panelTitle}>dev-gui</h1>
      <p style={styles.panelSubtitle}>Softwareschmiede-Fabrik — wähle eine Ansicht</p>

      {/* Four tiles (AC1) — grid on desktop, stacked on narrow */}
      <div style={styles.tileGrid} role="list">
        {TILES.map(({ id, label, description }) => (
          <Tile
            key={id}
            id={id}
            label={label}
            description={description}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </main>
  );
}

/**
 * Single tile — activatable via click and keyboard (Tab + Enter/Space). (AC1)
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   description: string,
 *   onNavigate: (view: string) => void
 * }} props
 */
function Tile({ id, label, description, onNavigate }) {
  function activate() {
    onNavigate(id);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }

  return (
    <div
      role="listitem"
      style={styles.tileWrapper}
    >
      {/*
        Using <button> satisfies keyboard accessibility naturally:
        Tab focusable, Enter/Space activated, no role override needed.
        Touch-target ≥ 44 px via minHeight/minWidth.
      */}
      <button
        type="button"
        style={styles.tile}
        aria-label={`${label} — ${description}`}
        onClick={activate}
        onKeyDown={handleKeyDown}
        data-view={id}
      >
        <span style={styles.tileLabel}>{label}</span>
        <span style={styles.tileDesc}>{description}</span>
      </button>
    </div>
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────

/**
 * AppShell — root component. Owns the hash-router and renders:
 *   - EntryPanel when view === 'panel'
 *   - NavBar + matching view component otherwise
 */
export function AppShell() {
  const { view, navigate } = useHashRouter();

  // EntryPanel — no NavBar, full-screen (AC1)
  if (view === 'panel') {
    return (
      <div style={styles.shell}>
        <EntryPanel onNavigate={navigate} />
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      {/* Persistent navigation (AC4) */}
      <NavBar currentView={view} onNavigate={navigate} />

      {/* Active view
          NOTE (Terminal lifecycle): FactoryView is only rendered while view === 'factory'.
          When the user navigates away, FactoryView unmounts and the Terminal component
          (and its underlying node-pty PTY session) is cleaned up via its useEffect
          teardown. Re-entering the factory view starts a fresh session. */}
      <div style={styles.viewPort}>
        {view === 'factory'    && <FactoryView    onNavigate={navigate} />}
        {view === 'github'     && <GitHubView     onNavigate={navigate} />}
        {view === 'vps'        && <VpsView        onNavigate={navigate} />}
        {view === 'cloudflare' && <CloudflareView onNavigate={navigate} />}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Shell wrapper
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    background: '#1a1a1a',
    fontFamily: 'system-ui, sans-serif',
  },

  // ── View port (below NavBar)
  viewPort: {
    flex: 1,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  },

  // ── NavBar
  nav: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0 4px',
    padding: '6px 12px',
    background: '#0d0d0d',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },
  navHome: {
    padding: '6px 12px',
    color: '#9ca3af',
    textDecoration: 'none',
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 4,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    marginRight: 8,
  },
  navLink: {
    padding: '6px 12px',
    color: '#9ca3af',
    textDecoration: 'none',
    fontSize: 13,
    borderRadius: 4,
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
  },
  navLinkActive: {
    color: '#e5e7eb',
    background: '#1e293b',
  },

  // ── Entry Panel
  panelOuter: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: '40px 24px',
    overflowY: 'auto',
  },
  panelTitle: {
    margin: '0 0 8px',
    fontSize: 32,
    fontWeight: 700,
    color: '#e5e7eb',
    textAlign: 'center',
  },
  panelSubtitle: {
    margin: '0 0 40px',
    fontSize: 15,
    color: '#9ca3af',
    textAlign: 'center',
  },

  // ── Tile grid — 2 × 2 on desktop, 1 column on narrow
  tileGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 16,
    width: '100%',
    maxWidth: 720,
  },
  tileWrapper: {
    // no extra styles — just a semantic list-item wrapper
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    width: '100%',
    minHeight: 120,
    padding: '20px 24px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    color: '#d4d4d4',
    // Focus ring — visible, not outline:none (coder lesson 2026-05-27)
    // Browser default outline applies; we ensure the button is not stripped.
  },
  tileLabel: {
    display: 'block',
    fontSize: 18,
    fontWeight: 700,
    color: '#e5e7eb',
    marginBottom: 8,
  },
  tileDesc: {
    display: 'block',
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 1.5,
  },
};
