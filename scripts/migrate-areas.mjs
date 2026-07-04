#!/usr/bin/env node
/**
 * scripts/migrate-areas.mjs — Bereichs-Migration dev-gui (S-296, bereichs-migration-dev-gui AC1–AC8).
 * Idempotenter One-Shot ohne Fremd-Dependencies (Projekt hält YAML handgeparst):
 * seedet board/areas.yaml (11 Bereiche, AreaWriter-Serialisierungsformat), stempelt
 * feature.area/story.area gemaess versionierter Zuordnungstabelle (UNKLAR -> Fragenkatalog,
 * kein Raten), archiviert terminale Storys via BoardWriter.archiveDoneStories, stempelt
 * Spec-Frontmatter area, schreibt docs/migration/areas-open-questions.md (+ .json).
 * Kein Netz, keine Secrets, byte-schonend (patchTopLevelFields / Frontmatter-Zeilen-Insert),
 * atomar (tmp+rename).
 */
import { readFile, writeFile, rename, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardWriter, patchTopLevelFields } from '../src/BoardWriter.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = path.basename(REPO);
const AREAS = [["board", "Board", "Kanban, Storys, Filter, Archiv, Live-Push", 1], ["fabrik-arbeiten", "Fabrik/Arbeiten", "Cockpit, Drains, Befehls-Ausloesung, Abschlussberichte", 2], ["nachtwaechter", "Nachtwaechter", "Nacht-Drain, Auto-Retro, Budget-Schutz", 3], ["einstellungen", "Einstellungen", "Settings-Panel, Credentials, Workspace-Pfad", 4], ["vps", "VPS", "Server-Verwaltung, SSH-Keys/-Terminal", 5], ["deployment", "Deployment", "Deploy-Orchestrierung, Cloudflare, Container", 6], ["benachrichtigungen", "Benachrichtigungen", "ntfy, Events, Meldeklassen", 7], ["obsidian", "Obsidian", "Vault, Ingest, Sync, Fragenkatalog", 8], ["sicherung", "Sicherung", "Backup, Restore", 9], ["spezifikation", "Spezifikation", "Doku-Ansicht, Reconcile", 10], ["retro-lernen", "Retro/Lernen", "RetroView, Trends, Verbesserungs-Board", 11]];
const FEATURE_MAP = {"F-001": "UNKLAR", "F-002": "retro-lernen", "F-003": "board", "F-004": "spezifikation", "F-005": "fabrik-arbeiten", "F-006": "fabrik-arbeiten", "F-007": "board", "F-008": "board", "F-009": "deployment", "F-010": "UNKLAR", "F-011": "fabrik-arbeiten", "F-012": "UNKLAR", "F-013": "deployment", "F-014": "vps", "F-015": "deployment", "F-016": "deployment", "F-017": "deployment", "F-018": "vps", "F-019": "board", "F-020": "board", "F-021": "retro-lernen", "F-022": "retro-lernen", "F-023": "vps", "F-024": "deployment", "F-025": "benachrichtigungen", "F-026": "deployment", "F-027": "deployment", "F-028": "deployment", "F-029": "nachtwaechter", "F-030": "board", "F-031": "spezifikation", "F-032": "deployment", "F-033": "spezifikation", "F-034": "spezifikation", "F-035": "einstellungen", "F-036": "spezifikation", "F-037": "einstellungen", "F-038": "spezifikation", "F-039": "fabrik-arbeiten", "F-040": "fabrik-arbeiten", "F-041": "fabrik-arbeiten", "F-042": "fabrik-arbeiten", "F-043": "fabrik-arbeiten", "F-044": "board", "F-045": "board", "F-046": "board", "F-047": "fabrik-arbeiten", "F-048": "board", "F-049": "board", "F-050": "obsidian", "F-051": "fabrik-arbeiten", "F-052": "vps", "F-053": "fabrik-arbeiten", "F-054": "einstellungen", "F-055": "nachtwaechter", "F-056": "benachrichtigungen", "F-057": "fabrik-arbeiten", "F-058": "fabrik-arbeiten", "F-059": "board", "F-060": "board", "F-061": "board", "F-062": "board", "F-063": "spezifikation", "F-064": "board"};
const SPEC_MAP = {"access-and-guardrails": "deployment", "app-shell-navigation": "fabrik-arbeiten", "app-stack-alexstuder-webpage": "deployment", "app-stack-brew-assistent": "deployment", "app-stack-rapt-dashboard": "deployment", "audit-spec-main-pane": "spezifikation", "autonome-board-abarbeitung": "board", "bereichs-migration-dev-gui": "board", "bereichs-modell": "board", "bitwarden-master-key-unlock": "einstellungen", "bitwarden-new-device-otp": "einstellungen", "board-abarbeitungs-strategie": "fabrik-arbeiten", "board-feature-archive": "board", "board-feature-collapse": "board", "board-filter-feature-status-consistency": "board", "board-live-sse": "board", "board-status-verworfen": "board", "board-storys-archivieren": "board", "claude-auth-health": "einstellungen", "claude-code-oauth-token": "einstellungen", "cloudflare-reconciliation": "deployment", "compose-stack-deployment": "deployment", "cost-mode-model-check": "fabrik-arbeiten", "credential-backup": "deployment", "credential-bootstrap-status": "einstellungen", "credential-key-flow": "einstellungen", "credential-key-rotation": "einstellungen", "credential-key-status-transparency": "einstellungen", "credential-master-key-decoupling": "einstellungen", "credential-runtime-unlock": "einstellungen", "credential-unlock-dialog": "einstellungen", "dashboard-deployment-tile": "fabrik-arbeiten", "deploy-lifecycle": "deployment", "deployment": "deployment", "drain-completion-report": "fabrik-arbeiten", "drain-done-notification": "benachrichtigungen", "drain-restart-robustness": "fabrik-arbeiten", "fabric-intake-dialog": "fabrik-arbeiten", "fabrik-arbeiten-layout": "fabrik-arbeiten", "factory-status": "fabrik-arbeiten", "feature-status-derivation": "board", "flow-trigger": "fabrik-arbeiten", "fswatcher-crash-hardening": "fabrik-arbeiten", "ghcr-image-list": "deployment", "ghcr-image-list-app-token": "deployment", "github-app-key-format-tolerant": "deployment", "github-app-token-unification": "einstellungen", "github-repo-clone": "fabrik-arbeiten", "github-repo-create": "fabrik-arbeiten", "github-repos-overview": "fabrik-arbeiten", "hardening": "UNKLAR", "headless-arg-finalize-safety": "fabrik-arbeiten", "headless-budget-limit-detection": "nachtwaechter", "headless-manual-drain": "fabrik-arbeiten", "headless-parallel-drain": "nachtwaechter", "headless-reconcile-runner": "spezifikation", "idea-specify-background-status": "fabrik-arbeiten", "idea-specify-chat": "fabrik-arbeiten", "ideen-inbox": "board", "local-image-test": "deployment", "new-story-chat": "fabrik-arbeiten", "night-budget-guard": "nachtwaechter", "notification-event-defaults": "benachrichtigungen", "obsidian-project-intake": "obsidian", "obsidian-question-catalog": "obsidian", "obsidian-sync-trigger": "obsidian", "obsidian-vault-config": "obsidian", "plugin-auto-update": "deployment", "projekt-cockpit-navigation": "fabrik-arbeiten", "projekt-spezifikation-anzeige": "spezifikation", "push-notifications": "benachrichtigungen", "questions-pending-notification": "benachrichtigungen", "reconcile-inline-feedback": "spezifikation", "reconcile-trigger": "spezifikation", "retro-auto-queue": "fabrik-arbeiten", "retro-auto-trigger": "fabrik-arbeiten", "retro-train-board-local": "retro-lernen", "retro-trend-backend": "retro-lernen", "retro-trend-frontend": "retro-lernen", "retro-view-backend": "retro-lernen", "retro-view-frontend": "retro-lernen", "settings-credentials": "einstellungen", "settings-panel-navigation": "einstellungen", "settings-shell": "einstellungen", "settings-ssh-keys": "einstellungen", "spec-audit-view": "spezifikation", "spec-bereich-filter": "spezifikation", "ssh-key-generation": "vps", "ssh-key-rotation": "vps", "stack-deploy-orchestration": "deployment", "story-detail-ansicht": "board", "story-detail-yaml-fallback": "board", "story-idee-bereich-zuordnung": "board", "story-specify-finalize-visibility": "fabrik-arbeiten", "studis-kanban-board-ux": "board", "taktgeber-nachtwaechter": "nachtwaechter", "team-detail-related-refs": "retro-lernen", "team-detail-scroll": "retro-lernen", "team-entity-icons": "retro-lernen", "team-knowledge-add": "retro-lernen", "team-train-trigger": "retro-lernen", "team-view-backend": "retro-lernen", "team-view-frontend": "retro-lernen", "terminal-bridge": "fabrik-arbeiten", "terminal-frontend": "fabrik-arbeiten", "token-usage-meter": "nachtwaechter", "view-cloudflare": "deployment", "view-github": "fabrik-arbeiten", "view-vps": "vps", "vps-cloud-init-setup": "deployment", "vps-compose-control": "vps", "vps-container-overview": "deployment", "vps-create-options": "vps", "vps-delete": "deployment", "vps-dynamic-ssh-targets": "deployment", "vps-provider-boundary": "vps", "vps-readiness-gate": "deployment", "vps-rebuild-backup": "vps", "vps-ssh-key-assignment": "vps", "vps-ssh-terminal": "vps", "vps-tunnel-drift-notify": "deployment", "vps-tunnel-existence-gate": "deployment", "vps-tunnel-provisioning": "deployment", "vps-tunnel-self-heal": "deployment", "webpage-infra-decommission": "deployment", "workspace-health-hinweis": "deployment", "workspace-path-config": "einstellungen", "workspace-repos": "einstellungen"};

async function atomicWrite(p, content) {
  const tmp = p + '.tmp-migrate';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, p);
}

/** Erstes Top-Level-Feld `key: value` lesen (Projektkonvention, kein YAML-Parser). */
function parseField(content, key) {
  const m = content.match(new RegExp('^' + key + ':\\s*(.*)$', 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

function yamlSingleQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

const open_questions = [];

// ── AC1: areas.yaml seeden (idempotent, AreaWriter-Format) ────────────────────
async function seedAreas() {
  const p = path.join(REPO, 'board/areas.yaml');
  const existing = existsSync(p) ? await readFile(p, 'utf8') : '';
  const have = new Set([...existing.matchAll(/^- id:\s*(\S+)/gm)].map((m) => m[1]));
  const missing = AREAS.filter(([id]) => !have.has(id));
  if (missing.length === 0) { console.log(`AC1 areas.yaml: vollstaendig (${have.size} Bereiche)`); return; }
  const lines = existing ? [existing.trimEnd()] : [];
  for (const [id, name, description, order] of missing) {
    lines.push(`- id: ${id}`);
    lines.push(`  name: ${yamlSingleQuote(name)}`);
    lines.push(`  order: ${order}`);
    lines.push(`  description: ${yamlSingleQuote(description)}`);
  }
  await atomicWrite(p, lines.join('\n') + '\n');
  console.log(`AC1 areas.yaml: ${missing.length} ergaenzt`);
}

// ── AC2/AC3: Features + Storys stempeln (byte-schonend, skip wenn vorhanden) ──
async function stampYaml(dir, getArea, kind) {
  const dirP = path.join(REPO, dir);
  let stamped = 0, skipped = 0;
  for (const f of (await readdir(dirP)).filter((x) => x.endsWith('.yaml'))) {
    const p = path.join(dirP, f);
    const content = await readFile(p, 'utf8');
    if (/^area:\s*\S/m.test(content)) { skipped++; continue; }
    const id = parseField(content, 'id');
    const area = getArea(content, id);
    if (area === 'UNKLAR') {
      open_questions.push({ kind, id, title: parseField(content, 'title') ?? '', grund: 'Zuordnung mehrdeutig (Tabelle: UNKLAR)' });
      continue;
    }
    if (area == null) { open_questions.push({ kind, id, title: parseField(content, 'title') ?? '', grund: 'nicht in Zuordnungstabelle / Parent bereichslos' }); continue; }
    const patched = patchTopLevelFields(content, { area }, { allowAppend: true });
    await atomicWrite(p, patched);
    stamped++;
  }
  console.log(`AC2/AC3 ${kind}: ${stamped} gestempelt, ${skipped} bereits vorhanden`);
}

// ── AC5: Spec-Frontmatter stempeln ────────────────────────────────────────────
async function stampSpecs() {
  const dirP = path.join(REPO, 'docs/specs');
  let stamped = 0, skipped = 0;
  for (const f of (await readdir(dirP)).filter((x) => x.endsWith('.md') && !x.startsWith('_template'))) {
    const slug = f.replace(/\.md$/, '');
    const p = path.join(dirP, f);
    const content = await readFile(p, 'utf8');
    if (/^area:\s/m.test(content)) { skipped++; continue; }
    const area = SPEC_MAP[slug];
    if (area === 'UNKLAR') { open_questions.push({ kind: 'spec', id: slug, title: slug, grund: 'Zuordnung mehrdeutig (Tabelle: UNKLAR)' }); continue; }
    if (area == null) { open_questions.push({ kind: 'spec', id: slug, title: slug, grund: 'nicht in Zuordnungstabelle' }); continue; }
    const patched = content.replace(/^(status:[^\n]*\n)/m, `$1area: ${area}\n`);
    if (patched === content) { open_questions.push({ kind: 'spec', id: slug, title: slug, grund: 'kein status:-Anker im Frontmatter' }); continue; }
    await atomicWrite(p, patched);
    stamped++;
  }
  console.log(`AC5 Specs: ${stamped} gestempelt, ${skipped} bereits vorhanden`);
}

// ── AC6: Fragenkatalog-Artefakt ───────────────────────────────────────────────
async function writeQuestions() {
  const dirP = path.join(REPO, 'docs/migration');
  await mkdir(dirP, { recursive: true });
  const md = ['# Bereichs-Migration — offene Zuordnungen', '',
    open_questions.length ? 'Folgende Eintraege blieben bewusst OHNE Bereichs-Stempel (kein Raten, AC6):' : 'Keine offenen Zuordnungen — alles gestempelt.', '',
    ...open_questions.map((q) => `- **${q.kind} ${q.id}**${q.title && q.title !== q.id ? ' — ' + q.title : ''} _(Grund: ${q.grund})_`), ''].join('\n');
  await atomicWrite(path.join(dirP, 'areas-open-questions.md'), md);
  await atomicWrite(path.join(dirP, 'areas-open-questions.json'), JSON.stringify(open_questions, null, 1) + '\n');
  console.log(`AC6 Fragenkatalog: ${open_questions.length} offene Eintraege`);
}

await seedAreas();
await stampYaml('board/features', (_c, id) => FEATURE_MAP[id], 'feature');
const featureAreaById = new Map();
for (const f of (await readdir(path.join(REPO, 'board/features'))).filter((x) => x.endsWith('.yaml'))) {
  const c = await readFile(path.join(REPO, 'board/features', f), 'utf8');
  const id = parseField(c, 'id');
  const area = c.match(/^area:\s*(\S+)/m)?.[1];
  if (id && area) featureAreaById.set(id, area);
}
await stampYaml('board/stories', (c) => {
  const parent = parseField(c, 'parent');
  const viaParent = featureAreaById.get(parent);
  if (viaParent) return viaParent;
  // Fallback (AC3-Präzisierung): Bereich der referenzierten Spec — präziser als ein
  // UNKLAR-Sammel-Parent (F-001 "Initial" u.ä. bündelte bereichsübergreifende Storys).
  const spec = parseField(c, 'spec');
  if (spec) {
    const slug = spec.replace(/^docs\/specs\//, '').replace(/\.md$/, '');
    const viaSpec = SPEC_MAP[slug];
    if (viaSpec && viaSpec !== 'UNKLAR') return viaSpec;
  }
  return FEATURE_MAP[parent] === 'UNKLAR' ? 'UNKLAR' : null;
}, 'story');
// ── AC4: terminale Storys archivieren (BoardWriter-Boundary) ──────────────────
const writer = new BoardWriter({ boardRootsEnv: path.dirname(REPO) });
const res = await writer.archiveDoneStories({ projectSlug: SLUG });
console.log(`AC4 archiviert: ${JSON.stringify(res).slice(0, 120)}`);
await stampSpecs();
await writeQuestions();
console.log('Migration fertig.');
