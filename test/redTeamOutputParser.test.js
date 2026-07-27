/**
 * @file redTeamOutputParser.test.js — Unit tests for the fail-safe red-team
 * output parser (docs/specs/red-team-scan-per-container.md).
 *
 * Covers (red-team-scan-per-container): AC24
 *
 *   AC24 — fail-safe parser: extracts `{ findings, checks, auswertbar }` from
 *   the captured runner output; `severity ∈ {low,medium,high,critical}`,
 *   `testort ∈ {direkt,öffentlich}`, per-check `ampel ∈ {gruen,gelb,rot}`;
 *   NEVER invents findings/checks; NEVER throws; and — the confirmed real
 *   format (agents/red-team.md §Ausgabe, skills/red-team/SKILL.md §5) — the
 *   current headless End-JSON (`{status,pr,findings_count,audit_block,
 *   retro_recommended}`) carries only a COUNT, no per-finding/-check detail,
 *   so parsing it yields the honest fail-safe result (`auswertbar:false`),
 *   never a fabricated "clean" claim from the count alone.
 */

import { describe, it, expect } from '@jest/globals';
import { parseRedTeamOutput } from '../src/redTeamOutputParser.js';

describe('redTeamOutputParser — AC24 (a): fail-safe on the CONFIRMED real red-team output format', () => {
  it('the real headless End-JSON (findings_count only, no per-finding detail) → auswertbar:false, empty arrays', () => {
    const output =
      'some assistant commentary\n' +
      '{"status":"done","pr":"https://github.com/org/repo/pull/42","findings_count":3,"audit_block":true,"retro_recommended":false}';

    const result = parseRedTeamOutput(output);

    expect(result).toEqual({ findings: [], checks: [], auswertbar: false });
  });

  it('a no-op End-JSON (findings_count: 0) also stays auswertbar:false (never fabricates a "clean" claim)', () => {
    const output = '{"status":"no-op","pr":null,"findings_count":0,"audit_block":true,"retro_recommended":false}';

    const result = parseRedTeamOutput(output);

    expect(result.auswertbar).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it('a "blocked" End-JSON (Allowlist-STOPP) stays auswertbar:false', () => {
    const output = '{"status":"blocked","pr":null,"findings_count":0,"audit_block":false,"retro_recommended":false}';

    expect(parseRedTeamOutput(output)).toEqual({ findings: [], checks: [], auswertbar: false });
  });
});

describe('redTeamOutputParser — AC24 (b): auswertbar case — a well-formed findings/checks payload is accepted', () => {
  it('extracts valid findings + checks from an embedded JSON object', () => {
    const output = `
      irrelevant leading text
      {"findings":[
        {"id":"f1","severity":"high","kind":"xss","testort":"direkt","titel":"Reflected XSS"},
        {"id":"f2","severity":"low","kind":"header","testort":"öffentlich","titel":"Missing CSP","detail":"no CSP header","checkId":"c2"}
      ],"checks":[
        {"id":"c1","titel":"XSS-Check","testort":"direkt","ampel":"rot"},
        {"id":"c2","titel":"Security-Header-Check","testort":"öffentlich","ampel":"gelb","detail":"CSP fehlt"}
      ]}
      trailing text
    `;

    const result = parseRedTeamOutput(output);

    expect(result.auswertbar).toBe(true);
    expect(result.findings).toEqual([
      { id: 'f1', severity: 'high', kind: 'xss', testort: 'direkt', titel: 'Reflected XSS' },
      {
        id: 'f2',
        severity: 'low',
        kind: 'header',
        testort: 'öffentlich',
        titel: 'Missing CSP',
        detail: 'no CSP header',
        checkId: 'c2',
      },
    ]);
    expect(result.checks).toEqual([
      { id: 'c1', titel: 'XSS-Check', testort: 'direkt', ampel: 'rot' },
      { id: 'c2', titel: 'Security-Header-Check', testort: 'öffentlich', ampel: 'gelb', detail: 'CSP fehlt' },
    ]);
  });

  it('a payload with checks but zero findings is auswertbar:true (a clean, fully-tested run is a real result, not a fabrication)', () => {
    const output = '{"findings":[],"checks":[{"id":"c1","titel":"TLS-Check","testort":"direkt","ampel":"gruen"}]}';

    const result = parseRedTeamOutput(output);

    expect(result.auswertbar).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.checks).toEqual([{ id: 'c1', titel: 'TLS-Check', testort: 'direkt', ampel: 'gruen' }]);
  });

  it('strips ANSI escape codes before extraction (real PTY-adjacent capture may contain them)', () => {
    const output = '\x1b[32m{"findings":[{"id":"f1","severity":"critical","kind":"sqli","testort":"direkt","titel":"SQLi"}],"checks":[]}\x1b[0m';

    const result = parseRedTeamOutput(output);

    expect(result.auswertbar).toBe(true);
    expect(result.findings).toHaveLength(1);
  });
});

describe('redTeamOutputParser — AC24 (c): invalid entries are dropped, never invented', () => {
  it('drops a finding with an invalid severity, keeps the valid ones', () => {
    const output = JSON.stringify({
      findings: [
        { id: 'bad', severity: 'catastrophic', kind: 'x', testort: 'direkt', titel: 'bad' },
        { id: 'good', severity: 'medium', kind: 'x', testort: 'direkt', titel: 'good' },
      ],
      checks: [],
    });

    const result = parseRedTeamOutput(output);

    expect(result.findings).toEqual([{ id: 'good', severity: 'medium', kind: 'x', testort: 'direkt', titel: 'good' }]);
  });

  it('drops a finding with an invalid testort', () => {
    const output = JSON.stringify({
      findings: [{ id: 'f1', severity: 'high', kind: 'x', testort: 'irgendwo', titel: 'x' }],
      checks: [],
    });

    expect(parseRedTeamOutput(output).findings).toEqual([]);
  });

  it('drops a finding missing a required field (titel)', () => {
    const output = JSON.stringify({
      findings: [{ id: 'f1', severity: 'high', kind: 'x', testort: 'direkt' }],
      checks: [],
    });

    expect(parseRedTeamOutput(output).auswertbar).toBe(false);
  });

  it('drops a check with an invalid ampel value', () => {
    const output = JSON.stringify({
      findings: [],
      checks: [{ id: 'c1', titel: 'x', testort: 'direkt', ampel: 'blau' }],
    });

    expect(parseRedTeamOutput(output)).toEqual({ findings: [], checks: [], auswertbar: false });
  });

  it('deduplicates findings/checks by id across multiple JSON fragments in the same output', () => {
    const frag = { findings: [{ id: 'f1', severity: 'high', kind: 'x', testort: 'direkt', titel: 'x' }], checks: [] };
    const output = `${JSON.stringify(frag)}\n${JSON.stringify(frag)}`;

    expect(parseRedTeamOutput(output).findings).toHaveLength(1);
  });

  it('never leaks unknown/extra fields from the source object (security floor — only the vetted allowlist survives)', () => {
    const output = JSON.stringify({
      findings: [
        {
          id: 'f1',
          severity: 'high',
          kind: 'x',
          testort: 'direkt',
          titel: 'x',
          secretToken: 'sk-should-not-leak',
          absolutePath: '/Users/alex/should-not-leak',
        },
      ],
      checks: [],
    });

    const result = parseRedTeamOutput(output);

    expect(result.findings).toEqual([{ id: 'f1', severity: 'high', kind: 'x', testort: 'direkt', titel: 'x' }]);
    expect(JSON.stringify(result)).not.toMatch(/secretToken|should-not-leak/);
  });
});

describe('redTeamOutputParser — AC24 (d): parser never throws (best-effort, fail-safe)', () => {
  it('non-string input → fail-safe result, no throw', () => {
    expect(() => parseRedTeamOutput(undefined)).not.toThrow();
    expect(parseRedTeamOutput(undefined)).toEqual({ findings: [], checks: [], auswertbar: false });
    expect(parseRedTeamOutput(null)).toEqual({ findings: [], checks: [], auswertbar: false });
    expect(parseRedTeamOutput(42)).toEqual({ findings: [], checks: [], auswertbar: false });
  });

  it('empty string → fail-safe result', () => {
    expect(parseRedTeamOutput('')).toEqual({ findings: [], checks: [], auswertbar: false });
    expect(parseRedTeamOutput('   \n  ')).toEqual({ findings: [], checks: [], auswertbar: false });
  });

  it('free-text output with no JSON at all → fail-safe result, no throw', () => {
    const output = 'Ziel: myapp (Allowlist: bestanden)\nScan: nuclei · 12 Roh-Funde → 0 bestätigt\nkeine JSON-Ausgabe hier';

    expect(() => parseRedTeamOutput(output)).not.toThrow();
    expect(parseRedTeamOutput(output)).toEqual({ findings: [], checks: [], auswertbar: false });
  });

  it('malformed/truncated JSON fragment does not crash the parser', () => {
    const output = '{"findings": [ { "id": "f1", "severity": "high"  <truncated garbage {{{ }}}} unbalanced';

    expect(() => parseRedTeamOutput(output)).not.toThrow();
  });

  it('a findings array containing non-object entries (null/string/number) is ignored, not invented', () => {
    const output = JSON.stringify({ findings: [null, 'oops', 42, { id: 'f1', severity: 'low', kind: 'x', testort: 'direkt', titel: 'x' }], checks: [] });

    const result = parseRedTeamOutput(output);

    expect(result.findings).toEqual([{ id: 'f1', severity: 'low', kind: 'x', testort: 'direkt', titel: 'x' }]);
  });
});
