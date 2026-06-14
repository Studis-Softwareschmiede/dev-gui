/**
 * RetroTrendView.jsx — Retro-Trend: Momentum-Board (Bump-/Slope-Chart) für die
 * Trajektorien-Sicht der Self-Improvement-Effektivität der Fabrik.
 *
 * retro-trend-frontend:
 *   AC1  — Einstieg über markanten „Retro-Trend"-Link im TeamView-Kopfbereich (dort implementiert).
 *   AC2  — Route `retro-trend` (in useHashRouter + AppShell registriert); Deep-Link #/retro-trend.
 *   AC3  — Browser-Back/Forward via Hash-Router (geerbt aus app-shell-navigation).
 *   AC4  — Drei Radio-Buttons „Knowledge Packs" / „Agent-Defs" / „Skills" in role="radiogroup";
 *           Default: Knowledge Packs; je Wechsel GET /api/retro/trend?category=<gewählt>;
 *           aria-busy/aria-live Ladezustand; Stale-Response-Guard (überholte Antwort verworfen).
 *   AC5  — Inline-SVG Bump-/Slope-Chart: X=Retro-Läufe chronologisch, Y=Momentum, Mittellinie 0;
 *           eine Linie je Bahn aus lanes[]; Legende zur Y-Richtung.
 *   AC6  — A11y WCAG 2.1 AA: Text-Labels an Linien + Form-Marker je Punkt (nicht nur Farbe);
 *           Punkte mit title/aria-label; Radio-Gruppe Pfeiltasten/Tab; sichtbare Fokusringe;
 *           Touch-Targets ≥ 44px; aria-live für Ladezustand.
 *   AC7  — Skills-Platzhalter: lanes:[] + placeholder → erkennbarer Hinweis, kein Crash.
 *   AC8  — Leerzustand (empty:true / leere lanes+runs) → „Noch keine Trenddaten", kein Crash.
 *   AC9  — Fehlerzustand: role=alert, Shell + Radio-Gruppe bleiben bedienbar.
 *   AC10 — Dark-Theme (#1a1a1a/#111/#0d0d0d, Text #e5e7eb/#9ca3af); responsiv (Desktop neben-
 *           einander, schmal gestapelt); SVG skaliert responsiv (viewBox + width:100%).
 *   AC11 — Strikt read-only: nur GET /api/retro/trend; kein dangerouslySetInnerHTML/innerHTML;
 *           keine externe Chart-/Markdown-/Router-Bibliothek; keine Secrets im Bundle.
 *
 * A11y (WCAG 2.1 AA):
 *   - Radio-Gruppe: role="radiogroup", Pfeiltasten + Tab, sichtbare Fokusringe.
 *   - Bahnen nicht allein über Farbe: Text-Labels an den Linien, Form-Marker an Punkten.
 *   - Datenpunkte: <title> + aria-label mit Bahn, Lauf, Momentum.
 *   - Touch-Targets ≥ 44px (Radio-Wrapper).
 *   - aria-live="polite" + aria-busy für Ladezustand.
 *   - Fehlermeldung: role="alert".
 *   - KEIN outline:none (Coder-Lesson 2026-05-27).
 *
 * Security (Floor):
 *   - Kein dangerouslySetInnerHTML / kein innerHTML.
 *   - Nur /api/retro/trend aufgerufen (hinter AccessGuard).
 *   - Keine Secrets im Bundle.
 *   - Keine neue externe Bibliothek.
 *
 * @param {{ onNavigate: (view: string) => void }} props
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Konstanten ────────────────────────────────────────────────────────────────

/** Verfügbare Kategorien mit Label und API-Wert. */
const CATEGORIES = [
  { value: 'knowledge', label: 'Knowledge Packs' },
  { value: 'agents',    label: 'Agent-Defs' },
  { value: 'skills',    label: 'Skills' },
];

/** Farbpalette für SVG-Bahnen (Dark-Theme-kompatibel). */
const LANE_COLORS = [
  '#60a5fa', // blau
  '#34d399', // grün
  '#f87171', // rot
  '#fbbf24', // gelb
  '#a78bfa', // lila
  '#f472b6', // pink
  '#38bdf8', // hellblau
  '#fb923c', // orange
  '#4ade80', // hellgrün
  '#c084fc', // hellviolett
];

/** Form-Marker-Sequenz für Bahnen (unabhängig von Farbe, AC6). */
const LANE_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'];

// ── SVG-Hilfsfunktionen ───────────────────────────────────────────────────────

/**
 * Berechnet die SVG-Koordinaten für alle Punkte über alle Bahnen.
 *
 * @param {{ lanes: Array, runs: Array }} data
 * @param {{ width: number, height: number, paddingX: number, paddingY: number }} layout
 * @returns {{ laneCoords: Map<string, Array<{x,y,point}>>, yMin: number, yMax: number, midY: number }}
 */
function computeLayout(data, layout) {
  const { width, height, paddingX, paddingY } = layout;
  const drawW = width - 2 * paddingX;
  const drawH = height - 2 * paddingY;

  const runCount = data.runs.length;
  if (runCount === 0) {
    return { laneCoords: new Map(), yMin: 0, yMax: 0, midY: paddingY + drawH / 2 };
  }

  // Alle Momentum-Werte sammeln, um Y-Range zu bestimmen
  let yMin = 0;
  let yMax = 0;
  for (const lane of data.lanes) {
    for (const pt of lane.points) {
      if (pt.momentum < yMin) yMin = pt.momentum;
      if (pt.momentum > yMax) yMax = pt.momentum;
    }
  }

  // Etwas Spielraum um den Range (mindestens ±1)
  const absMax = Math.max(Math.abs(yMin), Math.abs(yMax), 1);
  const dataMin = -absMax;
  const dataMax = absMax;
  const dataRange = dataMax - dataMin;

  // Mittellinie auf Y=0 zentrieren
  const midY = paddingY + drawH / 2;

  /**
   * Mapt einen Momentum-Wert auf SVG-Y (invertiert: höhere Werte = oben).
   * @param {number} momentum
   * @returns {number}
   */
  function toY(momentum) {
    if (dataRange === 0) return midY;
    return paddingY + drawH - ((momentum - dataMin) / dataRange) * drawH;
  }

  /**
   * Mapt einen Lauf-Index auf SVG-X.
   * @param {number} idx
   * @returns {number}
   */
  function toX(idx) {
    if (runCount <= 1) return paddingX + drawW / 2;
    return paddingX + (idx / (runCount - 1)) * drawW;
  }

  // Bahn-Index der Läufe ermitteln (Lauf-Run-Slug → X-Index)
  const runIndexMap = new Map(data.runs.map((r, i) => [r.run, i]));

  const laneCoords = new Map();
  for (const lane of data.lanes) {
    const coords = lane.points.map((pt) => {
      const xIdx = runIndexMap.has(pt.run) ? runIndexMap.get(pt.run) : 0;
      return {
        x: toX(xIdx),
        y: toY(pt.momentum),
        point: pt,
      };
    });
    laneCoords.set(lane.id, coords);
  }

  return { laneCoords, yMin: dataMin, yMax: dataMax, midY, toX, toY };
}

// ── Form-Marker-Komponente ────────────────────────────────────────────────────

/**
 * Rendert einen SVG-Form-Marker an einem Datenpunkt (AC6: nicht nur Farbe).
 *
 * @param {{ cx: number, cy: number, shape: string, color: string, size: number }} props
 */
function ShapeMarker({ cx, cy, shape, color, size = 6 }) {
  const s = size;
  switch (shape) {
    case 'square':
      return (
        <rect
          x={cx - s / 2}
          y={cy - s / 2}
          width={s}
          height={s}
          fill={color}
          stroke="#0d0d0d"
          strokeWidth={1}
        />
      );
    case 'triangle':
      return (
        <polygon
          points={`${cx},${cy - s} ${cx - s * 0.866},${cy + s / 2} ${cx + s * 0.866},${cy + s / 2}`}
          fill={color}
          stroke="#0d0d0d"
          strokeWidth={1}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
          fill={color}
          stroke="#0d0d0d"
          strokeWidth={1}
        />
      );
    case 'cross':
      return (
        <g stroke={color} strokeWidth={2}>
          <line x1={cx - s / 2} y1={cy - s / 2} x2={cx + s / 2} y2={cy + s / 2} />
          <line x1={cx + s / 2} y1={cy - s / 2} x2={cx - s / 2} y2={cy + s / 2} />
        </g>
      );
    case 'circle':
    default:
      return (
        <circle
          cx={cx}
          cy={cy}
          r={s / 2}
          fill={color}
          stroke="#0d0d0d"
          strokeWidth={1}
        />
      );
  }
}

// ── MomentumBoard (SVG) ───────────────────────────────────────────────────────

/**
 * Momentum-Board als Inline-SVG Bump-/Slope-Chart.
 * X-Achse: Retro-Läufe chronologisch; Y-Achse: Momentum um Mittellinie 0.
 * Eine Linie je Bahn; Labels + Form-Marker an Linien/Punkten (AC6: nicht nur Farbe).
 * Datenpunkte mit zugänglichem Text (<title>/aria-label, AC6).
 * SVG mit viewBox + width:100% für responsives Scaling (AC10).
 *
 * @param {{ lanes: Array, runs: Array }} props
 */
function MomentumBoard({ lanes, runs }) {
  const SVG_W = 700;
  const SVG_H = 320;
  const PAD_X = 56;
  const PAD_TOP = 24;
  const PAD_BOT = 48; // Platz für X-Achsenbeschriftung

  const layout = { width: SVG_W, height: SVG_H, paddingX: PAD_X, paddingY: PAD_TOP };
  const { laneCoords, midY } = computeLayout({ lanes, runs }, layout);

  const drawH = SVG_H - PAD_TOP - PAD_BOT;
  const drawW = SVG_W - 2 * PAD_X;
  const runCount = runs.length;

  // X-Positionen für Läufe
  function toX(idx) {
    if (runCount <= 1) return PAD_X + drawW / 2;
    return PAD_X + (idx / (runCount - 1)) * drawW;
  }

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      style={styles.svg}
      role="img"
      aria-label="Momentum-Board: Trajektorie der Self-Improvement-Effektivität"
    >
      {/* Mittellinie (Y=0) */}
      <line
        x1={PAD_X}
        y1={midY}
        x2={SVG_W - PAD_X}
        y2={midY}
        stroke="#4b5563"
        strokeWidth={1.5}
        strokeDasharray="4 3"
      />
      {/* "0"-Label an der Mittellinie */}
      <text x={PAD_X - 6} y={midY + 4} textAnchor="end" fontSize={11} fill="#6b7280">
        0
      </text>

      {/* Y-Achsen-Beschriftungen (Verbesserung oben, Verschlechterung unten) */}
      <text x={PAD_X - 6} y={PAD_TOP + 10} textAnchor="end" fontSize={10} fill="#6b7280">
        +
      </text>
      <text x={PAD_X - 6} y={PAD_TOP + drawH - 4} textAnchor="end" fontSize={10} fill="#6b7280">
        −
      </text>

      {/* X-Achsen-Tick-Beschriftungen (Lauf-Slugs/Daten) */}
      {runs.map((run, idx) => (
        <text
          key={`xtick-${run.run}`}
          x={toX(idx)}
          y={SVG_H - PAD_BOT + 16}
          textAnchor="middle"
          fontSize={10}
          fill="#6b7280"
        >
          {run.date || run.run}
        </text>
      ))}

      {/* Bahnen: Linien + Marker + Labels */}
      {lanes.map((lane, laneIdx) => {
        const color = LANE_COLORS[laneIdx % LANE_COLORS.length];
        const shape = LANE_SHAPES[laneIdx % LANE_SHAPES.length];
        const coords = laneCoords.get(lane.id) ?? [];

        // Polyline-Punkte
        const pointsStr = coords.map((c) => `${c.x},${c.y}`).join(' ');

        // Label-Position: letzter Punkt der Bahn
        const lastCoord = coords[coords.length - 1];
        const labelX = lastCoord ? lastCoord.x + 6 : 0;
        const labelY = lastCoord ? lastCoord.y + 4 : 0;

        return (
          <g key={lane.id} aria-label={`Bahn ${lane.label}`}>
            {/* Linienzug (nur wenn >= 2 Punkte) */}
            {coords.length >= 2 && (
              <polyline
                points={pointsStr}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )}

            {/* Form-Marker + zugänglicher Text an jedem Datenpunkt (AC6) */}
            {coords.map((c, ptIdx) => {
              const rulesText = c.point.contributingRules?.length
                ? ` (Regeln: ${c.point.contributingRules.join(', ')})`
                : '';
              const titleText = `${lane.label} — Lauf ${c.point.run} (${c.point.date}): Momentum ${c.point.momentum.toFixed(2)}${rulesText}`;
              return (
                <g
                  key={`${lane.id}-pt-${ptIdx}`}
                  aria-label={titleText}
                  role="img"
                >
                  <title>{titleText}</title>
                  <ShapeMarker cx={c.x} cy={c.y} shape={shape} color={color} size={8} />
                </g>
              );
            })}

            {/* Text-Label an der letzten Position der Bahn (AC6: nicht nur Farbe) */}
            {lastCoord && (
              <text
                x={labelX}
                y={labelY}
                fontSize={10}
                fill={color}
                fontWeight={600}
              >
                {lane.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Legende ────────────────────────────────────────────────────────────────────

/**
 * Legende mit Bahnen + Erläuterung der Y-Richtung (AC5, AC6).
 *
 * @param {{ lanes: Array }} props
 */
function BoardLegend({ lanes }) {
  return (
    <div style={styles.legend} aria-label="Legende">
      {/* Y-Richtungssinn (AC5) */}
      <div style={styles.legendDirection}>
        <span style={styles.legendUp}>▲ Steigend = Verbesserung (Defektrate gesunken)</span>
        <span style={styles.legendDown}>▼ Fallend = Verschlechterung (Defektrate gestiegen)</span>
      </div>

      {/* Bahn-Legende: Farbe + Form + Label (AC6: nicht nur Farbe) */}
      {lanes.length > 0 && (
        <div style={styles.legendItems} aria-label="Bahnen">
          {lanes.map((lane, idx) => {
            const color = LANE_COLORS[idx % LANE_COLORS.length];
            const shape = LANE_SHAPES[idx % LANE_SHAPES.length];
            return (
              <span key={lane.id} style={styles.legendItem}>
                {/* Form-Marker (inline SVG, klein) */}
                <svg width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden="true">
                  <ShapeMarker cx={7} cy={7} shape={shape} color={color} size={10} />
                </svg>
                <span style={{ color, fontWeight: 600, fontSize: 12 }}>{lane.label}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── RetroTrendView ─────────────────────────────────────────────────────────────

/**
 * @param {{ onNavigate: (view: string) => void }} props
 */
export function RetroTrendView({ onNavigate: _onNavigate }) {
  // ── State: aktive Kategorie
  const [category, setCategory] = useState('knowledge');

  // ── State: Daten + Ladezustand
  const [loadState, setLoadState] = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [loadError, setLoadError] = useState('');
  const [data, setData] = useState(null); // { category, lanes, runs, empty?, placeholder? }

  // ── Stale-Response-Guard: Generation-Counter (AC4)
  const genRef = useRef(0);

  // ── Fetch bei Kategorie-Wechsel (AC4) ─────────────────────────────────────
  const fetchTrend = useCallback((cat) => {
    const myGen = ++genRef.current;
    setLoadState('loading');
    setLoadError('');

    fetch(`/api/retro/trend?category=${encodeURIComponent(cat)}`)
      .then((res) => {
        if (!res.ok) return Promise.reject(new Error(`HTTP ${res.status}`));
        return res.json();
      })
      .then((json) => {
        // Stale-Guard: veraltete Antwort verwerfen
        if (myGen !== genRef.current) return;
        setData(json);
        setLoadState('ok');
      })
      .catch((err) => {
        if (myGen !== genRef.current) return;
        setLoadError(err.message || 'Netzwerkfehler');
        setLoadState('error');
      });
  }, []);

  // ── Einmaliger Load beim Mount mit Default-Kategorie (AC4) ────────────────
  useEffect(() => {
    fetchTrend('knowledge');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once

  // ── Radio-Wechsel (AC4) ───────────────────────────────────────────────────
  function handleCategoryChange(newCat) {
    if (newCat === category) return;
    setCategory(newCat);
    fetchTrend(newCat);
  }

  // ── Tastatur-Navigation innerhalb der RadioGroup (Pfeiltasten, AC6) ───────
  function handleRadioKeyDown(e, currentIdx) {
    let nextIdx = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (currentIdx + 1) % CATEGORIES.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (currentIdx - 1 + CATEGORIES.length) % CATEGORIES.length;
    }
    if (nextIdx !== null) {
      e.preventDefault();
      const newCat = CATEGORIES[nextIdx].value;
      handleCategoryChange(newCat);
      // Fokus auf das neu gewählte Radio setzen
      document.querySelector(`[data-radio="${newCat}"]`)?.focus();
    }
  }

  // ── Derived states ────────────────────────────────────────────────────────
  const isSkillsPlaceholder =
    loadState === 'ok' && data && category === 'skills' && data.placeholder;
  const isEmpty =
    loadState === 'ok' && data && data.empty === true;
  const hasLanes =
    loadState === 'ok' && data && !isSkillsPlaceholder && !isEmpty && data.lanes?.length > 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <main style={styles.main} aria-label="Retro-Trend-Ansicht">
      <h1 style={styles.h1}>Retro-Trend</h1>

      {/* ── Kategorie-Umschalter: RadioGroup (AC4, AC6) ── */}
      <div
        role="radiogroup"
        aria-label="Artefakt-Kategorie"
        style={styles.radioGroup}
      >
        {CATEGORIES.map((cat, idx) => {
          const isSelected = category === cat.value;
          return (
            <label
              key={cat.value}
              style={{
                ...styles.radioLabel,
                ...(isSelected ? styles.radioLabelSelected : {}),
              }}
            >
              <input
                type="radio"
                name="trend-category"
                value={cat.value}
                checked={isSelected}
                onChange={() => handleCategoryChange(cat.value)}
                onKeyDown={(e) => handleRadioKeyDown(e, idx)}
                style={styles.radioInput}
                data-radio={cat.value}
                aria-label={cat.label}
              />
              <span style={styles.radioText}>{cat.label}</span>
            </label>
          );
        })}
      </div>

      {/* ── aria-live Region für Ladezustand (AC6) ── */}
      <div
        aria-live="polite"
        aria-busy={loadState === 'loading' ? 'true' : 'false'}
        style={styles.srOnly}
      >
        {loadState === 'loading' && 'Lade Trend-Daten…'}
        {loadState === 'ok' && `Trend-Daten geladen für ${category}.`}
        {loadState === 'error' && `Fehler beim Laden: ${loadError}`}
      </div>

      {/* ── Ladezustand sichtbar (AC4, AC6) ── */}
      {loadState === 'loading' && (
        <div style={styles.statusMsg}>
          Lade Trend-Daten…
        </div>
      )}

      {/* ── Fehlerzustand (AC9) ── */}
      {loadState === 'error' && (
        <div role="alert" style={styles.errorMsg}>
          Fehler beim Laden der Trend-Daten: {loadError}
        </div>
      )}

      {/* ── Skills-Platzhalter (AC7) ── */}
      {isSkillsPlaceholder && (
        <div style={styles.placeholderMsg} role="status" aria-label="Skills-Platzhalter">
          {data.placeholder || '— noch keine Messmethode für Skill-Güte'}
        </div>
      )}

      {/* ── Leerzustand Phase 0 (AC8) ── */}
      {isEmpty && (
        <div style={styles.statusMsg} role="status">
          Noch keine Trenddaten
        </div>
      )}

      {/* ── Momentum-Board (AC5, AC6, AC10) ── */}
      {hasLanes && (
        <div style={styles.boardWrapper}>
          <MomentumBoard lanes={data.lanes} runs={data.runs} />
          <BoardLegend lanes={data.lanes} />
        </div>
      )}

      {/* ── Leere Bahnen aber nicht skills und nicht empty (z.B. agents mit 0 Bahnen) ── */}
      {loadState === 'ok' && data && !isSkillsPlaceholder && !isEmpty && data.lanes?.length === 0 && (
        <div style={styles.statusMsg} role="status">
          Noch keine Trenddaten
        </div>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // ── Main landmark
  main: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
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

  // ── RadioGroup (AC4, AC6) — Touch-Targets ≥ 44px via label padding
  radioGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 20,
    flexShrink: 0,
  },

  radioLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 44,
    padding: '10px 16px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    color: '#9ca3af',
    fontSize: 13,
    cursor: 'pointer',
    // Focus ring preserved — no outline:none (A11y, WCAG 2.1 AA)
  },

  radioLabelSelected: {
    background: '#1e293b',
    border: '1px solid #334155',
    color: '#e5e7eb',
  },

  radioInput: {
    // Natives Radio-Input — sichtbarer Fokusring bleibt erhalten (no outline:none)
    accentColor: '#60a5fa',
    cursor: 'pointer',
  },

  radioText: {
    fontSize: 13,
  },

  // ── Status / Hint Messages
  statusMsg: {
    color: '#9ca3af',
    fontSize: 14,
    padding: '16px 0',
    flexShrink: 0,
  },

  placeholderMsg: {
    color: '#6b7280',
    fontSize: 14,
    fontStyle: 'italic',
    padding: '20px 16px',
    background: '#111',
    borderRadius: 8,
    border: '1px solid #2a2a2a',
    marginTop: 8,
    flexShrink: 0,
  },

  errorMsg: {
    color: '#f87171',
    fontSize: 14,
    padding: '12px 16px',
    background: '#2a1a1a',
    borderRadius: 6,
    border: '1px solid #7f1d1d',
    marginBottom: 16,
    flexShrink: 0,
  },

  // ── Board Wrapper (scrollbar bei Overflow)
  boardWrapper: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    background: '#111',
    borderRadius: 8,
    border: '1px solid #2a2a2a',
    padding: '16px',
  },

  // ── SVG Board — responsiv (AC10)
  svg: {
    width: '100%',
    height: 'auto',
    display: 'block',
    overflow: 'visible',
  },

  // ── Legende (AC5, AC6)
  legend: {
    marginTop: 12,
    borderTop: '1px solid #2a2a2a',
    paddingTop: 12,
  },

  legendDirection: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 10,
    fontSize: 12,
    color: '#6b7280',
  },

  legendUp: {
    color: '#34d399',
    fontWeight: 600,
  },

  legendDown: {
    color: '#f87171',
    fontWeight: 600,
  },

  legendItems: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
  },

  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
  },

  // Screenreader-only (aria-live, visuell verborgen)
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border: 0,
  },
};
