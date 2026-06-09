/**
 * TeamView.jsx — Team-Ansicht: Agenten, Skills und Knowledge der Fabrik (AC1–AC10).
 *
 * team-view-frontend:
 *   AC1  — Kachel „Team" im Einstiegs-Panel (durch AppShell bereitgestellt).
 *   AC2  — Route `team` → diese Komponente (durch AppShell + useHashRouter bereitgestellt).
 *   AC3  — Lädt GET /api/team einmalig beim Mount; gruppierte Liste AGENTEN/SKILLS/KNOWLEDGE;
 *           Knowledge zusätzlich nach `group` sortiert/gruppiert; aria-busy/aria-live Ladezustand.
 *   AC4  — Auswahl per Maus oder Tastatur → GET /api/team/:kind/:id → Detail-Pane mit
 *           Metadaten-Badges + gerendertem Markdown-Body; aktiver Eintrag trägt aria-current.
 *   AC5  — Markdown via markdownLite (kein dangerouslySetInnerHTML / innerHTML).
 *   AC6  — Leerzustand: klarer Hinweis „Kein agent-flow-Plugin gefunden" statt leerem Screen.
 *   AC7  — Fehlerzustand: erkennbare Fehlermeldung; Shell bleibt bedienbar.
 *   AC8  — A11y WCAG 2.1 AA: Landmark, semantische Liste, sichtbare Fokusringe,
 *           Touch-Targets ≥ 44 px, aria-current, Tastatur-Bedienung, kein outline:none.
 *   AC9  — 2 Spalten Desktop / gestapelt auf schmal; Dark-Theme konsistent.
 *   AC10 — Keine Secrets im Bundle; kein dangerouslySetInnerHTML; nur /api/team* aufgerufen.
 *
 * A11y (WCAG 2.1 AA):
 *   - Semantische Navigationsliste mit aria-label.
 *   - Sichtbarer Fokusring — KEIN outline:none (Coder-Lesson 2026-05-27).
 *   - Touch-Targets ≥ 44 px für Listeneinträge.
 *   - aria-busy / aria-live Ladezustand.
 *   - aria-current auf aktivem Eintrag.
 *   - Bedeutung nicht allein über Farbe.
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/team* Endpunkte (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useCallback } from 'react';
import { MarkdownLite } from './markdownLite.jsx';

// ── TeamView ──────────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function TeamView({ onNavigate: _onNavigate }) {
  // ── State
  const [loadState, setLoadState] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'
  const [loadError, setLoadError] = useState('');

  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [knowledge, setKnowledge] = useState([]);

  const [selected, setSelected] = useState(null); // { kind, id } or null
  const [detail, setDetail] = useState(null); // fetched detail object or null
  const [detailState, setDetailState] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'
  const [detailError, setDetailError] = useState('');

  // ── Load overview on mount (exactly once — AC3)
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError('');

    fetch('/api/team')
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setAgents(data.agents ?? []);
        setSkills(data.skills ?? []);
        setKnowledge(data.knowledge ?? []);
        setLoadState('ok');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });

    return () => { cancelled = true; };
  }, []); // empty deps = mount once

  // ── Load detail when selection changes (AC4)
  const loadDetail = useCallback((kind, id) => {
    setSelected({ kind, id });
    setDetailState('loading');
    setDetailError('');
    setDetail(null);

    fetch(`/api/team/${kind}/${id}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((data) => {
        setDetail(data);
        setDetailState('ok');
      })
      .catch((err) => {
        setDetailError(err.message || 'Netzwerkfehler');
        setDetailState('error');
      });
  }, []);

  // ── Derived: is data available and all lists empty? (AC6)
  const isEmpty =
    loadState === 'ok' &&
    agents.length === 0 &&
    skills.length === 0 &&
    knowledge.length === 0;

  // ── Group knowledge by group field (AC3)
  const knowledgeByGroup = groupBy(knowledge, (k) => k.group);
  const knowledgeGroups = Object.keys(knowledgeByGroup).sort((a, b) => a.localeCompare(b));

  // ── Render
  return (
    <main style={styles.main} aria-label="Team-Ansicht">
      <h1 style={styles.h1}>Team</h1>

      {/* Loading state — accessible (AC3, AC8) */}
      {loadState === 'loading' && (
        <div
          aria-busy="true"
          aria-live="polite"
          style={styles.statusMsg}
        >
          Lade Team-Daten…
        </div>
      )}

      {/* Error state for overview load (AC7) */}
      {loadState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden des Teams: {loadError}
        </div>
      )}

      {/* Empty state (AC6) */}
      {isEmpty && (
        <div style={styles.statusMsg} role="status">
          Kein agent-flow-Plugin gefunden. Bitte das Plugin installieren und neu laden.
        </div>
      )}

      {/* Master-Detail layout (AC3–AC4, AC9) */}
      {loadState === 'ok' && !isEmpty && (
        <div style={styles.layout}>
          {/* ── Master: Navigation list ── */}
          <nav style={styles.nav} aria-label="Team-Navigation">
            {/* AGENTEN section */}
            {agents.length > 0 && (
              <section aria-label="Agenten" style={styles.section}>
                <h2 style={styles.sectionHeading}>AGENTEN</h2>
                <ul style={styles.list} role="list">
                  {agents.map((agent) => (
                    <NavItem
                      key={`agent-${agent.id}`}
                      kind="agent"
                      item={agent}
                      isActive={selected?.kind === 'agent' && selected?.id === agent.id}
                      onSelect={loadDetail}
                    />
                  ))}
                </ul>
              </section>
            )}

            {/* SKILLS section */}
            {skills.length > 0 && (
              <section aria-label="Skills" style={styles.section}>
                <h2 style={styles.sectionHeading}>SKILLS</h2>
                <ul style={styles.list} role="list">
                  {skills.map((skill) => (
                    <NavItem
                      key={`skill-${skill.id}`}
                      kind="skill"
                      item={skill}
                      isActive={selected?.kind === 'skill' && selected?.id === skill.id}
                      onSelect={loadDetail}
                    />
                  ))}
                </ul>
              </section>
            )}

            {/* KNOWLEDGE section — grouped by group (AC3) */}
            {knowledge.length > 0 && (
              <section aria-label="Knowledge" style={styles.section}>
                <h2 style={styles.sectionHeading}>KNOWLEDGE</h2>
                {knowledgeGroups.map((group) => (
                  <div key={group} style={styles.knowledgeGroup}>
                    <h3 style={styles.groupHeading}>{group}</h3>
                    <ul style={styles.list} role="list">
                      {knowledgeByGroup[group].map((kn) => (
                        <NavItem
                          key={`knowledge-${kn.id}`}
                          kind="knowledge"
                          item={kn}
                          isActive={selected?.kind === 'knowledge' && selected?.id === kn.id}
                          onSelect={loadDetail}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            )}
          </nav>

          {/* ── Detail pane ── */}
          <div style={styles.detail} aria-label="Detail-Pane">
            {/* No selection yet */}
            {selected === null && (
              <p style={styles.hintMsg}>
                Wähle einen Eintrag aus der Liste aus.
              </p>
            )}

            {/* Detail loading */}
            {detailState === 'loading' && (
              <div aria-busy="true" aria-live="polite" style={styles.statusMsg}>
                Lade Details…
              </div>
            )}

            {/* Detail error (AC7) */}
            {detailState === 'error' && (
              <div role="alert" style={styles.errorMsg}>
                Fehler beim Laden der Details: {detailError}
              </div>
            )}

            {/* Detail content (AC4) */}
            {detailState === 'ok' && detail && (
              <DetailPane detail={detail} kind={selected?.kind} />
            )}
          </div>
        </div>
      )}
    </main>
  );
}

// ── NavItem ───────────────────────────────────────────────────────────────────

/**
 * Single list item in the navigation list.
 * Activatable by click and keyboard (Enter/Space) — AC4, AC8.
 *
 * @param {{
 *   kind: string,
 *   item: { id: string, name: string },
 *   isActive: boolean,
 *   onSelect: (kind: string, id: string) => void
 * }} props
 */
function NavItem({ kind, item, isActive, onSelect }) {
  function activate() {
    onSelect(kind, item.id);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }

  return (
    <li style={styles.listItem} role="listitem">
      <button
        type="button"
        style={{
          ...styles.navButton,
          ...(isActive ? styles.navButtonActive : {}),
        }}
        aria-current={isActive ? 'page' : undefined}
        onClick={activate}
        onKeyDown={handleKeyDown}
        data-kind={kind}
        data-id={item.id}
      >
        {item.name || item.id}
      </button>
    </li>
  );
}

// ── DetailPane ────────────────────────────────────────────────────────────────

/**
 * Detail pane: shows metadata badges and rendered Markdown body.
 *
 * @param {{ detail: object, kind: string }} props
 */
function DetailPane({ detail, kind }) {
  const { name, description, model, tools, group, body } = detail;

  return (
    <article style={styles.article}>
      {/* Title */}
      <h2 style={styles.detailTitle}>{name || detail.id}</h2>

      {/* Metadata badges (AC4) */}
      <div style={styles.badgeRow} aria-label="Metadaten">
        {/* Kind badge */}
        <span style={styles.badge} title="Art">
          {kind}
        </span>

        {/* Description badge */}
        {description && (
          <span style={styles.badge} title="Beschreibung">
            {description}
          </span>
        )}

        {/* Model badge (agents only) */}
        {model && (
          <span style={styles.badge} title="Modell">
            {model}
          </span>
        )}

        {/* Tools badges (agents only) */}
        {Array.isArray(tools) && tools.length > 0 &&
          tools.map((tool, idx) => (
            <span key={idx} style={styles.badgeTool} title="Tool">
              {tool}
            </span>
          ))
        }

        {/* Group badge (knowledge only) */}
        {group && (
          <span style={styles.badge} title="Gruppe">
            {group}
          </span>
        )}
      </div>

      {/* Rendered Markdown body (AC5 — via MarkdownLite, no dangerouslySetInnerHTML) */}
      {body && (
        <div style={styles.bodySection}>
          <MarkdownLite markdown={body} style={styles.markdownBody} />
        </div>
      )}
    </article>
  );
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Group an array by a key function.
 *
 * @template T
 * @param {T[]} arr
 * @param {(item: T) => string} keyFn
 * @returns {Record<string, T[]>}
 */
function groupBy(arr, keyFn) {
  const result = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
  }
  return result;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Main landmark
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    overflow: 'hidden',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  h1: {
    margin: '0 0 16px',
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
    flexShrink: 0,
  },

  // ── Status / hint messages
  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
  },
  hintMsg: {
    color: '#9ca3af',
    fontSize: 14,
    margin: 0,
  },
  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
  },

  // ── Master-Detail layout (AC9)
  // 2 columns on desktop; stacked on narrow via flex-wrap + minWidth trick
  layout: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },

  // ── Navigation (master / left column)
  nav: {
    flex: '0 0 240px',
    minWidth: 200,
    maxWidth: '100%',
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    padding: '12px 8px',
    border: '1px solid #2a2a2a',
  },

  section: {
    marginBottom: 16,
  },

  sectionHeading: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#9ca3af',
    margin: '0 0 8px 8px',
    textTransform: 'uppercase',
  },

  knowledgeGroup: {
    marginBottom: 8,
  },

  groupHeading: {
    fontSize: 11,
    fontWeight: 600,
    color: '#6b7280',
    margin: '8px 0 4px 8px',
    textTransform: 'capitalize',
  },

  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
  },

  listItem: {
    margin: '2px 0',
  },

  // Nav button — Touch-Target ≥ 44px (AC8)
  navButton: {
    display: 'block',
    width: '100%',
    minHeight: 44,
    padding: '10px 12px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: '#e5e7eb',
    fontSize: 13,
    textAlign: 'left',
    cursor: 'pointer',
    // Focus ring visible — no outline:none (coder lesson 2026-05-27)
  },
  navButtonActive: {
    background: '#1e293b',
    color: '#f0f9ff',
  },

  // ── Detail pane (right column)
  detail: {
    flex: 1,
    minWidth: 240,
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    padding: '16px 20px',
    border: '1px solid #2a2a2a',
  },

  article: {
    color: '#e5e7eb',
  },

  detailTitle: {
    margin: '0 0 12px',
    fontSize: 20,
    fontWeight: 700,
    color: '#e5e7eb',
  },

  // ── Badges (AC4)
  badgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },

  badge: {
    display: 'inline-block',
    padding: '3px 10px',
    background: '#1e293b',
    color: '#93c5fd',
    fontSize: 12,
    borderRadius: 12,
    border: '1px solid #334155',
    maxWidth: 320,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  badgeTool: {
    display: 'inline-block',
    padding: '3px 10px',
    background: '#1a2a1a',
    color: '#86efac',
    fontSize: 12,
    borderRadius: 12,
    border: '1px solid #14532d',
  },

  // ── Markdown body (AC5)
  bodySection: {
    borderTop: '1px solid #2a2a2a',
    paddingTop: 16,
  },

  markdownBody: {
    color: '#e5e7eb',
    fontSize: 14,
    lineHeight: 1.7,
    // Headings, code, pre, lists inherit layout
  },
};
