/**
 * Settings loader — scans `server/data/settings/*\/setting.md` and parses each
 * file's frontmatter + H2 sections into a `SettingDef`. The loaded set is
 * exposed through `loadSettings()` for `loadDefs` to splice into `GameDefs`,
 * and the active setting (chosen via `ACTIVE_SETTING_ID` env var, falling back
 * to the first loaded setting) is held in a module-level singleton so both AI
 * code paths can look up section content without threading defs through
 * every call.
 *
 * Markdown shape:
 *
 *   ---
 *   id: my_setting
 *   name: My Setting
 *   version: 1
 *   ruleset: srd-5.2.1
 *   summary: |
 *     One-paragraph summary always injected into every AI prompt.
 *   sections:
 *     - tone
 *     - geography
 *   ---
 *
 *   ## Tone
 *   ...body...
 *
 *   ## Geography
 *   ...body...
 *
 * The frontmatter's `sections` list is advisory — the loader treats every
 * `## ` heading in the body as a section regardless. `sectionsByName` is
 * keyed by the kebab-cased heading title (so "Geography & Climate" becomes
 * `geography-climate`).
 */
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import type { SettingDef, WorldbookEntry } from '../../shared/types.js';
import { loadServerConfig } from './serverConfig.js';

let activeSetting: SettingDef | null = null;

/** Singleton accessor — used by AIGM tools and prompt helpers that don't have
 *  direct access to `defs`. Returns null when no setting is active. */
export function getActiveSetting(): SettingDef | null {
  return activeSetting;
}

/** Set the active setting (called once during `loadDefs`). */
export function setActiveSetting(setting: SettingDef | null): void {
  activeSetting = setting;
}

/**
 * Look up an H2 section's body by kebab-case id (e.g. "geography"). Returns
 * null when there is no active setting or the section doesn't exist. Used by
 * the GM's `lookup_setting` tool.
 */
export function lookupSettingSection(sectionId: string): string | null {
  if (!activeSetting) return null;
  const key = kebabify(sectionId);
  return activeSetting.sectionsByName[key] ?? null;
}

/**
 * Look up a worldbook entry's body by kebab-case id (e.g. "concordat"). Used
 * by the GM's `lookup_worldbook` tool. Returns null when no setting is
 * active or the id is unknown.
 */
export function lookupWorldbookEntry(entryId: string): WorldbookEntry | null {
  if (!activeSetting) return null;
  const key = kebabify(entryId);
  return activeSetting.worldbookById[key] ?? null;
}

function kebabify(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the "Setting Context" block spliced into AI prompts. When no setting
 * is active returns an empty string so callers can unconditionally concatenate
 * the result.
 *
 * `mode: "full"` includes every section's body — used by the one-shot dev AI
 * which can't call a lookup tool. `mode: "summary"` returns only the
 * frontmatter summary + the section list — used by the in-game GM, which
 * pulls additional sections via `lookup_setting` as needed.
 */
export function settingPromptBlock(setting: SettingDef | null, mode: 'summary' | 'full'): string {
  if (!setting) return '';
  const lines: string[] = [];
  lines.push(`# Setting: ${setting.name}`);
  lines.push('');
  lines.push(setting.summary.trim());
  lines.push('');
  lines.push('Honor this setting. Do not invent named NPCs, locations, or factions outside of it; prefer the entities the setting supplies. When the player asks about lore you do not have memorised, the GM may answer "I do not know" rather than invent.');
  if (mode === 'summary') {
    if (setting.sections.length > 0) {
      lines.push('');
      lines.push(`Available canon sections (call the \`lookup_setting\` tool with a section id to fetch the body): ${setting.sections.join(', ')}.`);
    }
    if (setting.worldbook.length > 0) {
      lines.push('');
      // Group worldbook entries by type so the AI can scan for the topic
      // shape it's after (faction dossier vs named-NPC backstory vs
      // location). Untyped entries fall into "other".
      const byType = new Map<string, WorldbookEntry[]>();
      for (const e of setting.worldbook) {
        const t = e.type ?? 'other';
        if (!byType.has(t)) byType.set(t, []);
        byType.get(t)!.push(e);
      }
      const formatted = Array.from(byType.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, entries]) => {
          const ids = entries.map((e) => e.id).sort().join(', ');
          return `${t}: ${ids}`;
        })
        .join(' · ');
      lines.push(`Available worldbook entries (call the \`lookup_worldbook\` tool with an entry id to fetch the dossier) — ${formatted}.`);
    }
  } else {
    for (const id of setting.sections) {
      const body = setting.sectionsByName[id];
      if (!body) continue;
      lines.push('');
      lines.push(`## ${id}`);
      lines.push(body.trim());
    }
    for (const entry of setting.worldbook) {
      lines.push('');
      lines.push(`## Worldbook · ${entry.title}`);
      lines.push(entry.body.trim());
    }
  }
  return lines.join('\n');
}

/**
 * Scan `<dataDir>/settings/*\/setting.md`, parse each into a `SettingDef`,
 * pick the active one. Folders starting with `_` are skipped (reserved for
 * template / scratch). Invalid frontmatter is logged but doesn't abort the
 * scan — the other settings still load.
 */
export async function loadSettings(dataDir: string): Promise<{ settings: SettingDef[]; active: SettingDef | null }> {
  const root = join(dataDir, 'settings');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    activeSetting = null;
    return { settings: [], active: null };
  }
  const settings: SettingDef[] = [];
  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = join(root, name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
    } catch { continue; }
    const file = join(dir, 'setting.md');
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch {
      console.warn(`[settings] ${name}: no setting.md, skipping`);
      continue;
    }
    try {
      const def = parseSettingMarkdown(raw, name);
      const worldbook = await loadWorldbook(join(dir, 'worldbook'), name);
      def.worldbook = worldbook;
      def.worldbookById = Object.fromEntries(worldbook.map((e) => [e.id, e]));
      settings.push(def);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[settings] ${name}: parse failed — ${msg}`);
    }
  }
  // Active selection rule, in priority order:
  //   1. `server_config.json` `activeSettingId` (player's persisted choice
  //      from the Configuration page) matches a loaded setting → use it.
  //   2. ACTIVE_SETTING_ID env var (dev / CI override) matches → use it.
  //   3. The first non-`default` setting alphabetically → use it (so a user
  //      who has authored a real setting sees it active without any opt-in).
  //   4. The `default` setting (core SRD baseline) → use as fallback.
  //   5. No settings loaded → null (only shared SRD content is available).
  const config = await loadServerConfig(dataDir);
  const fromConfig = config.activeSettingId?.trim();
  const fromEnv = process.env.ACTIVE_SETTING_ID?.trim();
  let active: SettingDef | null = null;
  if (fromConfig) {
    active = settings.find((s) => s.id === fromConfig) ?? null;
    if (!active) console.warn(`[settings] server_config activeSettingId="${fromConfig}" not found among loaded settings`);
  }
  if (!active && fromEnv) {
    active = settings.find((s) => s.id === fromEnv) ?? null;
    if (!active) console.warn(`[settings] ACTIVE_SETTING_ID="${fromEnv}" not found among loaded settings`);
  }
  if (!active) active = settings.find((s) => s.id !== 'default') ?? null;
  if (!active) active = settings.find((s) => s.id === 'default') ?? null;
  activeSetting = active;
  if (active) console.log(`[settings] active: ${active.id} v${active.version}`);
  else console.log('[settings] no active setting — core rules only');
  return { settings, active };
}

/**
 * Resolve the on-disk directory for setting-owned content of a given type
 * (e.g. `characters`, `npcs`, `maps`, `saves`). Centralised so the loader,
 * the save routes, and the generator all agree on the path.
 *
 * Returns null when there is no active setting — the caller should treat
 * that as "no content available" (an empty roster) rather than fall back to
 * top-level paths, since top-level setting-owned folders no longer exist
 * after the Phase 2 migration.
 */
export function settingContentDir(dataDir: string, settingId: string | null, contentType: string): string | null {
  if (!settingId) return null;
  return `${dataDir}/settings/${settingId}/${contentType}`;
}

/**
 * Parse a single `setting.md`: split off the YAML-ish frontmatter, then walk
 * the body for `## ` headings. Each heading opens a new section; the lines
 * that follow become that section's body until the next heading or EOF.
 *
 * The frontmatter parser is a small subset of YAML — just enough to handle
 * `key: value`, `key: |` block scalars, and `key:` followed by `- item`
 * lists. Good enough for the template shape; saves pulling in `js-yaml`.
 */
function parseSettingMarkdown(raw: string, folderName: string): SettingDef {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('missing frontmatter (--- … ---)');
  const front = parseFrontmatter(m[1]);
  const body = m[2];

  const id = (front.id ?? folderName).toString().trim();
  const name = (front.name ?? id).toString().trim();
  const version = (front.version ?? '1').toString().trim();
  const ruleset = front.ruleset?.toString().trim();
  const summary = (front.summary ?? '').toString().trim();
  if (!summary) throw new Error('frontmatter `summary` is required');

  const { sections, sectionsByName } = extractSections(body);
  // worldbook / worldbookById are populated by `loadWorldbook` after the
  // base markdown is parsed — see the call site in `loadSettings`.
  return { id, name, version, ruleset, summary, sections, sectionsByName, worldbook: [], worldbookById: {} };
}

/**
 * Minimal frontmatter parser. Handles:
 *   key: scalar value
 *   key: |  (or `>`) followed by indented block lines
 *   key:    followed by `  - item` list lines
 * Unknown / malformed lines are silently skipped. The returned record's
 * values are strings or string arrays.
 */
function parseFrontmatter(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { i++; continue; }
    const key = kv[1];
    const rest = kv[2];
    if (rest === '|' || rest === '>') {
      // Block scalar — consume indented continuation lines.
      i++;
      const block: string[] = [];
      while (i < lines.length) {
        const cont = lines[i];
        if (cont.length === 0) { block.push(''); i++; continue; }
        if (/^\s+/.test(cont)) { block.push(cont.replace(/^\s+/, '')); i++; continue; }
        break;
      }
      out[key] = block.join(rest === '|' ? '\n' : ' ').trim();
      continue;
    }
    if (rest === '') {
      // Either an empty value or a list follows.
      i++;
      const items: string[] = [];
      while (i < lines.length) {
        const cont = lines[i];
        const li = /^\s+-\s+(.*)$/.exec(cont);
        if (!li) break;
        items.push(li[1].trim());
        i++;
      }
      if (items.length > 0) out[key] = items;
      else out[key] = '';
      continue;
    }
    // Inline list `[a, b, c]` or scalar.
    const inlineList = /^\[(.*)\]$/.exec(rest);
    if (inlineList) {
      out[key] = inlineList[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      out[key] = rest.replace(/^["']|["']$/g, '').trim();
    }
    i++;
  }
  return out;
}

/**
 * Walk `<settingDir>/worldbook/` and parse every `*.md` as a worldbook
 * entry. Missing folder → empty list (the feature is opt-in). Individual
 * parse failures are logged and skipped so one malformed file can't break
 * the whole load.
 */
async function loadWorldbook(dir: string, settingName: string): Promise<WorldbookEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: WorldbookEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('_') || name.startsWith('.')) continue;
    const file = join(dir, name);
    try {
      const s = await stat(file);
      if (!s.isFile()) continue;
    } catch { continue; }
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[settings] ${settingName}/worldbook/${name}: read failed — ${msg}`);
      continue;
    }
    const filenameId = name.replace(/\.md$/i, '');
    try {
      out.push(parseWorldbookEntry(raw, filenameId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[settings] ${settingName}/worldbook/${name}: parse failed — ${msg}`);
    }
  }
  return out;
}

/**
 * Parse one worldbook markdown file. Frontmatter is required but everything
 * inside is optional except (implicitly) `id`, which defaults to the
 * filename when missing. The body is whatever follows the closing `---` —
 * returned verbatim so the AIGM sees the author's prose untouched.
 */
function parseWorldbookEntry(raw: string, filenameId: string): WorldbookEntry {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('missing frontmatter (--- … ---)');
  const front = parseFrontmatter(m[1]);
  const body = m[2].trim();
  if (!body) throw new Error('empty body');

  const id = (front.id ?? filenameId).toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new Error('id required (frontmatter `id:` or non-empty filename)');
  const title = (front.title ?? id).toString().trim();
  const type = front.type ? front.type.toString().trim() : undefined;
  const relatedFactionId = front.relatedFactionId ? front.relatedFactionId.toString().trim() : undefined;
  const relatedNpcId = front.relatedNpcId ? front.relatedNpcId.toString().trim() : undefined;
  const tags = Array.isArray(front.tags) ? front.tags.map((t) => t.toString().trim()).filter(Boolean) : undefined;
  return { id, title, type, relatedFactionId, relatedNpcId, tags, body };
}

/**
 * Walk the body and split on `## ` headings. Each heading is kebab-cased to
 * a section id; the body up to the next heading (or EOF) is the section's
 * content. Anything before the first heading is discarded — it's normally an
 * intro blurb the prompt block already shows via `summary`.
 */
function extractSections(body: string): { sections: string[]; sectionsByName: Record<string, string> } {
  const sections: string[] = [];
  const sectionsByName: Record<string, string> = {};
  const re = /^##\s+(.+)$/gm;
  const headings: { id: string; lineEnd: number; lineStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) continue;
    headings.push({ id, lineStart: m.index, lineEnd: m.index + m[0].length });
  }
  for (let h = 0; h < headings.length; h++) {
    const start = headings[h].lineEnd;
    const end = h + 1 < headings.length ? headings[h + 1].lineStart : body.length;
    const content = body.slice(start, end).trim();
    // Skip placeholder sections (heading with no body). The AI shouldn't be
    // told it can look these up — `lookup_setting` would return empty.
    if (!content) continue;
    sections.push(headings[h].id);
    sectionsByName[headings[h].id] = content;
  }
  return { sections, sectionsByName };
}
