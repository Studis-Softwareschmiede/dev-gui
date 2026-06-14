/**
 * TeamView.jsx — Team-Ansicht: Agenten, Skills und Knowledge der Fabrik (AC1–AC10).
 *
 * team-view-frontend:
 *   AC1  — Kachel „Team" im Einstiegs-Panel (durch AppShell bereitgestellt).
 *          Markanter „Retro"-Link im Kopfbereich (beim <h1>Team</h1>), aktiviert
 *          onNavigate('retro') per Maus und Tastatur (Tab + Enter/Space).
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
 * team-detail-related-refs:
 *   AC7  — Agent-DetailPane: Sektionen „Zugehörige Skills" + „Zugehöriges Knowledge" als Chips;
 *           leere Liste → keine Sektion.
 *   AC8  — Chip-Klick (Maus + Tastatur Enter/Space) ruft loadDetail(kind, id); kein Voll-Reload.
 *   AC9  — Skill-/Knowledge-DetailPane: Sektion „Verwendet von" mit Agent-Chips;
 *           Chip-Klick ruft loadDetail('agent', id); leere Liste → keine Sektion.
 *   AC10 — Chips: fokussierbar, sichtbarer Fokusring, Tastatur Enter/Space, Bedeutung nicht
 *           nur über Farbe; kein dangerouslySetInnerHTML/innerHTML; keine externe Lib;
 *           keine Secrets; nur /api/team* aufgerufen.
 *
 * team-entity-icons:
 *   AC8  — NavItem rendert <EntityIcon> (aria-hidden) vor dem Namen; Name, aria-current und
 *           Fokus-/Tastaturverhalten bleiben unverändert.
 *   AC9  — DetailPane zeigt großes Kopf-Icon neben Titel (name/id) in Typ-Akzentfarbe.
 *   AC10 — Chips (relatedSkills/relatedKnowledge/usedByAgents) zeigen Mini-<EntityIcon>
 *           (aria-hidden) vor dem Label; Fokus/Tastatur/loadDetail-Verhalten unberührt.
 *   AC11 — Alle Icons aria-hidden; keine neuen API-Aufrufe/Endpunkte/Datenfelder;
 *           Icons leiten sich allein aus vorhandenem kind/id/group ab.
 *
 * A11y (WCAG 2.1 AA):
 *   - Semantische Navigationsliste mit aria-label.
 *   - Sichtbarer Fokusring — KEIN outline:none (Coder-Lesson 2026-05-27).
 *   - Touch-Targets ≥ 44 px für Listeneinträge.
 *   - Chips: Buttons, fokussierbar, sichtbarer Fokusring, Tastatur aktivierbar.
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
import { EntityIcon } from './icons/EntityIcon.jsx';

// ── TeamView ──────────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function TeamView({ onNavigate }) {
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
      <div style={styles.headerRow}>
        <h1 style={styles.h1}>Team</h1>
        {/* Retro-Link im Kopfbereich — team-view-frontend AC1 */}
        <button
          type="button"
          style={styles.retroLink}
          onClick={() => onNavigate('retro')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onNavigate('retro');
            }
          }}
          aria-label="Retro — Self-Improvement-Historie"
          data-nav="retro"
        >
          Retro
        </button>
        {/* Retro-Trend-Link im Kopfbereich — retro-trend-frontend AC1 */}
        <button
          type="button"
          style={styles.retroLink}
          onClick={() => onNavigate('retro-trend')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onNavigate('retro-trend');
            }
          }}
          aria-label="Retro-Trend — Momentum-Board"
          data-nav="retro-trend"
        >
          Retro-Trend
        </button>
      </div>

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

            {/* Detail content (AC4, AC7–AC10) */}
            {detailState === 'ok' && detail && (
              <DetailPane detail={detail} kind={selected?.kind} loadDetail={loadDetail} />
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
        {/* AC8 — entity icon before name, decorative (aria-hidden on EntityIcon) */}
        <EntityIcon kind={kind} id={item.id} group={item.group} size={16} />
        {item.name || item.id}
      </button>
    </li>
  );
}

// ── DetailPane ────────────────────────────────────────────────────────────────

/**
 * Detail pane: shows metadata badges, rendered Markdown body, and reference chip sections.
 *
 * team-detail-related-refs AC7–AC10:
 *   - Agent detail: "Zugehörige Skills" + "Zugehöriges Knowledge" chip sections.
 *   - Skill/Knowledge detail: "Verwendet von" chip section.
 *   - Chip click (mouse + keyboard) calls loadDetail(kind, id).
 *   - Empty list → section not rendered.
 *
 * @param {{ detail: object, kind: string, loadDetail: (kind: string, id: string) => void }} props
 */
function DetailPane({ detail, kind, loadDetail }) {
  const { name, description, model, tools, group, body, relatedSkills, relatedKnowledge, usedByAgents } = detail;

  return (
    <article style={styles.article}>
      {/* Title — AC9: large head-icon beside the title, accent-colored per type */}
      <div style={styles.detailTitleRow}>
        <EntityIcon kind={kind} id={detail.id} group={group} size={28} />
        <h2 style={styles.detailTitle}>{name || detail.id}</h2>
      </div>

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

      {/* Related Skills chips — agent detail (AC7, AC8, AC10) */}
      {Array.isArray(relatedSkills) && relatedSkills.length > 0 && (
        <RefChips
          heading="Zugehörige Skills"
          items={relatedSkills}
          targetKind="skill"
          onSelect={loadDetail}
        />
      )}

      {/* Related Knowledge chips — agent detail (AC7, AC8, AC10) */}
      {Array.isArray(relatedKnowledge) && relatedKnowledge.length > 0 && (
        <RefChips
          heading="Zugehöriges Knowledge"
          items={relatedKnowledge}
          targetKind="knowledge"
          onSelect={loadDetail}
        />
      )}

      {/* Used-by agents chips — skill/knowledge detail (AC9, AC10) */}
      {Array.isArray(usedByAgents) && usedByAgents.length > 0 && (
        <RefChips
          heading="Verwendet von"
          items={usedByAgents}
          targetKind="agent"
          onSelect={loadDetail}
        />
      )}

      {/* Rendered Markdown body (AC5 — via MarkdownLite, no dangerouslySetInnerHTML) */}
      {body && (
        <div style={styles.bodySection}>
          <MarkdownLite markdown={body} style={styles.markdownBody} />
        </div>
      )}
    </article>
  );
}

// ── RefChips ──────────────────────────────────────────────────────────────────

/**
 * A labelled section of clickable reference chips.
 * Each chip is a focusable button; activatable by mouse, Enter, or Space (AC8, AC10).
 * No section rendered when items list is empty — callers guard with length > 0 (AC7/AC9/AC10).
 *
 * A11y (WCAG 2.1 AA, AC10):
 *   - Native <button> → focusable, keyboard-activatable (Enter/Space built-in).
 *   - No outline:none — browser focus ring preserved.
 *   - Touch target: minHeight 32px + padding; chips are inline; gap + padding give ≥ 24px height
 *     with sufficient spacing (spec: "mindestens 24 px Höhe mit ausreichendem Padding/Abstand").
 *   - Meaning not solely through colour — visible text label always present.
 *   - No dangerouslySetInnerHTML / innerHTML.
 *
 * @param {{
 *   heading: string,
 *   items: Array<{ id: string, name?: string }>,
 *   targetKind: string,
 *   onSelect: (kind: string, id: string) => void
 * }} props
 */
function RefChips({ heading, items, targetKind, onSelect }) {
  return (
    <div style={styles.refSection} aria-label={heading}>
      <h3 style={styles.refHeading}>{heading}</h3>
      <div style={styles.chipRow} role="list">
        {items.map((item) => (
          <div key={item.id} role="listitem" style={styles.chipItem}>
            <button
              type="button"
              style={styles.chip}
              onClick={() => onSelect(targetKind, item.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(targetKind, item.id);
                }
              }}
              data-kind={targetKind}
              data-id={item.id}
            >
              {/* AC10 — mini-icon before label, decorative (aria-hidden on EntityIcon) */}
              <EntityIcon kind={targetKind} id={item.id} group={item.group} size={12} />
              {item.name || item.id}
            </button>
          </div>
        ))}
      </div>
    </div>
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
    minHeight: 0, // height-chain: lets the layout grid shrink below content height so detail can scroll (team-detail-scroll AC3)
    overflow: 'hidden',
    padding: '20px 24px',
    background: '#1a1a1a',
    color: '#e5e7eb',
  },

  // ── Header row: h1 + Retro-Link side-by-side (team-view-frontend AC1)
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginBottom: 16,
    flexShrink: 0,
  },

  h1: {
    margin: 0,
    fontSize: 24,
    fontWeight: 700,
    color: '#e5e7eb',
  },

  // Retro-Link button — markant, Touch-Target ≥ 44px, sichtbarer Fokusring (kein outline:none)
  retroLink: {
    minHeight: 44,
    padding: '10px 16px',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 6,
    color: '#93c5fd',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    // Focus ring preserved — no outline:none (A11y, WCAG 2.1 AA, team-view-frontend AC1, AC9)
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
  // CSS grid (NOT flex-wrap): a wrap-row sizes its line to content height, so the
  // detail pane grew past the viewport and overflow:hidden clipped it instead of
  // letting overflowY:'auto' scroll (team-detail-scroll AC1–AC3). A grid track is
  // bounded by the container, so each column (nav/detail) gets a real height limit
  // and scrolls independently. minmax(0,…) prevents column blow-out from long content.
  layout: {
    display: 'grid',
    gridTemplateColumns: 'minmax(180px, 240px) minmax(0, 1fr)',
    gap: 16,
    flex: 1,
    overflow: 'hidden',
    minHeight: 0,
  },

  // ── Navigation (master / left column)
  nav: {
    minWidth: 0, // grid item: width comes from the column track; minWidth:0 lets it shrink cleanly
    minHeight: 0, // grid item height is bounded by the track, so overflowY:'auto' actually scrolls (team-detail-scroll AC3)
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

  // Nav button — Touch-Target ≥ 44px (AC8); flex row for icon + name (AC8, team-entity-icons)
  navButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
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
    minWidth: 0, // grid item: width comes from the minmax(0,1fr) track; minWidth:0 prevents long content from blowing out the column
    minHeight: 0, // grid item height is bounded by the track, so overflowY:'auto' actually scrolls (team-detail-scroll AC1–AC3)
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    padding: '16px 20px',
    border: '1px solid #2a2a2a',
  },

  article: {
    color: '#e5e7eb',
  },

  // AC9 — flex row: large head-icon + title, vertically centered, gap between
  detailTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },

  detailTitle: {
    margin: 0,
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

  // ── Reference chip sections (team-detail-related-refs AC7–AC10)
  refSection: {
    borderTop: '1px solid #2a2a2a',
    paddingTop: 12,
    marginBottom: 12,
  },

  refHeading: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#9ca3af',
    margin: '0 0 8px',
    textTransform: 'uppercase',
  },

  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
  },

  chipItem: {
    display: 'inline-flex',
  },

  // Chip button — A11y: focus ring visible (no outline:none), Tastatur Enter/Space (native button)
  // Touch target: minHeight 32px + horizontal padding; spec allows ≥ 24 px with sufficient spacing.
  // flex row for mini-icon + label (AC10, team-entity-icons).
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    padding: '5px 12px',
    background: '#1e293b',
    color: '#93c5fd',
    fontSize: 12,
    borderRadius: 12,
    border: '1px solid #334155',
    cursor: 'pointer',
    // Focus ring preserved — no outline:none (AC10, Coder-Lesson 2026-05-27)
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
