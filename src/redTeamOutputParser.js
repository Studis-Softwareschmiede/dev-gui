/**
 * redTeamOutputParser — fail-safe Parser für die erfasste stdout/stderr-Ausgabe eines
 * `/agent-flow:red-team`-Laufs (docs/specs/red-team-scan-per-container.md AC24).
 *
 * **Format-Bestätigung (Spec-Pflicht, AC24 — geprüft gegen den aktuellen red-team-Skill):**
 * `agents/red-team.md` (§Ausgabe) + `skills/red-team/SKILL.md` (§5, Headless-Ausgabevertrag)
 * legen fest, dass ein headless (`claude -p`) Lauf mit **genau einem** maschinenlesbaren
 * End-JSON endet:
 *
 *   { "status": "done"|"no-op"|"blocked"|"needs-auth", "pr": "<url>"|null,
 *     "findings_count": <int>, "audit_block": <bool>, "retro_recommended": <bool> }
 *
 * Dieses End-JSON trägt **nur einen Zähler** (`findings_count`) — **keine** per-Fund-
 * Aufschlüsselung (`severity`/`kind`/`testort`/`titel`) und **keine** Prüfpunkt-Liste. Die
 * eigentlichen Fund-Details (Nuclei-JSONL, Board-Item-Texte, der Audit-Protokoll-Block in
 * `docs/red-team-audit.md`) entstehen als **Datei-/PR-Inhalt** des Agenten (Write-Tool-
 * Aufrufe) — sie werden in der captured stdout/stderr-Ausgabe **nicht** verlässlich
 * strukturiert echot. Das heutige reale Format erfüllt den AC24-Rückgabevertrag
 * (`{ findings:[{id,severity,kind,testort,titel,...}], checks:[...] }`) damit **nicht** —
 * dies ist die dokumentierte Format-Abweichung, auf die AC24 mit **fail-safe**
 * (`auswertbar:false`, leere Arrays) reagiert, statt Funde/Prüfpunkte zu erfinden.
 *
 * Damit ein künftiger, reicherer Lauf (End-JSON mit `findings`/`checks`-Arrays im exakten
 * Vertragsformat) diese Naht ohne Parser-Änderung nutzen kann, sucht dieser Parser
 * TROTZDEM aktiv nach solchen Arrays in jedem im Text erkennbaren JSON-Objekt — findet er
 * keine (heutiger Realfall), bleibt das Ergebnis ehrlich `auswertbar:false`.
 *
 * Fail-safe (bindend, Nicht-Ziele der Spec):
 *   - Parser wirft NIE (alles hinter try/catch, best-effort).
 *   - Erfindet NIE Funde/Prüfpunkte — nur Objekte, deren Pflichtfelder exakt dem
 *     Rückgabevertrag entsprechen (Enum-Validierung `severity`/`testort`/`ampel`),
 *     werden übernommen; alles andere wird verworfen (kein Rätselraten).
 *   - `auswertbar: false`, wenn weder ein valider Fund noch ein valider Prüfpunkt
 *     erkannt wurde — NIE ein implizites „sauber".
 *
 * Security (Floor, AC22/AC25): das Ergebnis trägt ausschliesslich die im Vertrag
 * genannten, vetted Kurz-Metadaten-Felder (Allowlist-Kopie der validierten Werte) — nie
 * die Roh-Ausgabe und nie unbekannte Zusatzfelder aus der Quelle (kein Secret-/Pfad-Leak
 * über ein unerwartetes Feld eines fremden JSON-Objekts im Output).
 *
 * @module redTeamOutputParser
 */

import { stripAnsi } from './TokenLimitWatcher.js';

/** @type {ReadonlySet<string>} */
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
/** @type {ReadonlySet<string>} */
const VALID_TESTORTE = new Set(['direkt', 'öffentlich']);
/** @type {ReadonlySet<string>} */
const VALID_AMPELN = new Set(['gruen', 'gelb', 'rot']);

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validiert + kopiert ein rohes Fund-Objekt in die Vertragsform (AC24) — nur die
 * bekannten Felder werden übernommen (Allowlist), unbekannte Zusatzfelder der Quelle
 * fallen weg (Security-Floor). Ungültig (Pflichtfeld fehlt/falscher Enum-Wert) → `null`.
 *
 * @param {unknown} raw
 * @returns {{id:string,severity:string,kind:string,testort:string,titel:string,detail?:string,checkId?:string}|null}
 */
function sanitizeFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!VALID_SEVERITIES.has(raw.severity)) return null;
  if (!isNonEmptyString(raw.kind)) return null;
  if (!VALID_TESTORTE.has(raw.testort)) return null;
  if (!isNonEmptyString(raw.titel)) return null;

  const finding = {
    id: raw.id,
    severity: raw.severity,
    kind: raw.kind,
    testort: raw.testort,
    titel: raw.titel,
  };
  if (isNonEmptyString(raw.detail)) finding.detail = raw.detail;
  if (isNonEmptyString(raw.checkId)) finding.checkId = raw.checkId;
  return finding;
}

/**
 * Validiert + kopiert ein rohes Prüfpunkt-Objekt in die Vertragsform (AC24) — analog
 * `sanitizeFinding()`.
 *
 * @param {unknown} raw
 * @returns {{id:string,titel:string,testort:string,ampel:string,detail?:string}|null}
 */
function sanitizeCheck(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isNonEmptyString(raw.id)) return null;
  if (!isNonEmptyString(raw.titel)) return null;
  if (!VALID_TESTORTE.has(raw.testort)) return null;
  if (!VALID_AMPELN.has(raw.ampel)) return null;

  const check = {
    id: raw.id,
    titel: raw.titel,
    testort: raw.testort,
    ampel: raw.ampel,
  };
  if (isNonEmptyString(raw.detail)) check.detail = raw.detail;
  return check;
}

/**
 * Findet alle balancierten Top-Level-`{...}`-Teilstrings im Text und parst jeden, der
 * gültiges JSON ist (ungültige Kandidaten werden übersprungen, kein Crash — best-effort,
 * String-Inhalte werden bei der Klammer-Zählung übersprungen, damit ein `}`/`{` innerhalb
 * eines String-Literals die Balance nicht verfälscht).
 *
 * @param {string} text
 * @returns {object[]}
 */
function extractJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          try {
            results.push(JSON.parse(candidate));
          } catch {
            // Ungültiges JSON-Fragment — überspringen, kein Crash (fail-safe).
          }
          start = -1;
        }
      }
    }
  }

  return results;
}

/**
 * Parst die erfasste kombinierte Ausgabe (stdout+stderr) eines `/agent-flow:red-team`-
 * Laufs auf strukturierte Funde + Prüfpunkte (AC24).
 *
 * @param {unknown} combinedOutput - z.B. `job.output` (`HeadlessRedTeamRunner#getJob()`,
 *   AC25 opt-in Feld).
 * @returns {{
 *   findings: Array<{id:string,severity:string,kind:string,testort:string,titel:string,detail?:string,checkId?:string}>,
 *   checks: Array<{id:string,titel:string,testort:string,ampel:string,detail?:string}>,
 *   auswertbar: boolean,
 * }}
 */
export function parseRedTeamOutput(combinedOutput) {
  try {
    if (typeof combinedOutput !== 'string' || combinedOutput.trim() === '') {
      return { findings: [], checks: [], auswertbar: false };
    }

    const clean = stripAnsi(combinedOutput);
    const candidates = extractJsonObjects(clean);

    const findingsById = new Map();
    const checksById = new Map();

    for (const obj of candidates) {
      if (!obj || typeof obj !== 'object') continue;

      if (Array.isArray(obj.findings)) {
        for (const rawFinding of obj.findings) {
          const finding = sanitizeFinding(rawFinding);
          if (finding && !findingsById.has(finding.id)) {
            findingsById.set(finding.id, finding);
          }
        }
      }

      if (Array.isArray(obj.checks)) {
        for (const rawCheck of obj.checks) {
          const check = sanitizeCheck(rawCheck);
          if (check && !checksById.has(check.id)) {
            checksById.set(check.id, check);
          }
        }
      }
    }

    const findings = [...findingsById.values()];
    const checks = [...checksById.values()];

    // Fail-safe (AC24): NUR wenn tatsächlich mindestens ein valider Fund ODER
    // Prüfpunkt erkannt wurde, gilt die Ausgabe als auswertbar — sonst NIE ein
    // erfundenes/implizites „sauber".
    return { findings, checks, auswertbar: findings.length > 0 || checks.length > 0 };
  } catch {
    // Jeder unerwartete Fehler (z.B. ein Prototype-Trick in einem JSON-Fragment) darf den
    // aufrufenden Lauf nie zum Absturz bringen — fail-safe, kein erfundenes Ergebnis.
    return { findings: [], checks: [], auswertbar: false };
  }
}
