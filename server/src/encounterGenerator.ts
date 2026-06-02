import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { GameDefs } from "./engine/types.js";
import { buildMapJson as sharedBuildMapJson } from "./engine/MapPersistence.js";
import { settingPromptBlock } from "./settings.js";

/** zod schemas for the two tool-output payload shapes Claude returns. The
 *  parsed result is narrowed back to the inferred interface so the rest of
 *  the file keeps using the same name. A schema mismatch surfaces as a
 *  clear `ZodError` at the call site instead of a downstream undefined-field
 *  crash during validation. */
const GeneratedMapPayloadSchema = z.object({
  name:        z.string(),
  description: z.string(),
  width:       z.number().int(),
  height:      z.number().int(),
  terrainData: z.array(z.number()),
  objectData:  z.array(z.number()),
});

const GeneratedPayloadSchema = z.object({
  encounterTitle:     z.string(),
  description:        z.string(),
  mapName:            z.string(),
  mapdescription:     z.string(),
  objective:          z.string(),
  customIntroduction: z.string(),
  customContext:      z.string(),
  completionFlag:     z.string().optional(),
  npcIds:             z.array(z.string()).optional(),
  allyIds:            z.array(z.string()).optional(),
  enemyIds:           z.array(z.string()).optional(),
  width:              z.number().int(),
  height:             z.number().int(),
  terrainData:        z.array(z.number()),
  objectData:         z.array(z.number()),
  startingZonesData:  z.array(z.number()),
});

/**
 * Encounter Generator — given a free-text prompt, asks Claude Sonnet to
 * author a complete one-off scenario: a Tiled-style map AND an EncounterDef
 * that references it. The model is grounded by the existing tile legend,
 * monster roster, and NPC roster so it can only use ids that actually exist.
 *
 * Truth flows down: every field returned by the model is validated against
 * the live `GameDefs` before any file is written. Malformed output is
 * rejected with a precise error string; partial saves are never written.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DATA_DIR   = join(__dirname, "..", "data");

export interface GenerateRequest {
  prompt: string;
  playerName?: string;
  playerClassName?: string;
}

export interface GeneratedScenario {
  mapId: string;
  encounterId: string;
}

export interface GeneratedMap {
  mapId: string;
  width: number;
  height: number;
  /** Flat row-major GID array for the terrain tile layer (length width*height). */
  terrainData: number[];
  /** Optional flat row-major GID array for the object tile layer. `0` = empty cell. Same length as `terrainData` when present. */
  objectData: number[];
  /** Display name authored by the model. */
  name: string;
  /** Short description authored by the model. */
  description: string;
}

/**
 * Public entry point. Returns the new mapId + encounterId on success.
 * Throws Error with a descriptive message on validation failure.
 */
export async function generateEncounter(
  anthropic: Anthropic,
  defs: GameDefs,
  req: GenerateRequest,
  disabledTiles: Record<string, number[]> = {},
): Promise<GeneratedScenario> {
  const validMonsterIds = new Set(defs.monsters.map((m) => m.id));
  const validNpcIds = new Set(defs.npcs.map((n) => n.id));
  const disabledGids = new Set<number>();
  for (const ids of Object.values(disabledTiles)) for (const id of ids) disabledGids.add(id);
  const validTileGids = new Set<number>();
  for (const k of Object.keys(defs.tileLegend.tiles)) {
    const gid = parseInt(k, 10);
    if (disabledGids.has(gid)) continue;
    validTileGids.add(gid);
  }
  const groundLayerGids = layerGidSet(defs, 'ground');
  const objectLayerGids = layerGidSet(defs, 'object');
  for (const gid of disabledGids) { groundLayerGids.delete(gid); objectLayerGids.delete(gid); }

  const system = buildSystemPrompt(defs, disabledGids);
  const user = buildUserPrompt(req);
  const tool = buildResponseTool();

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_scenario" },
    messages: [{ role: "user", content: user }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("Model did not return a tool_use block.");
  }
  const payload = GeneratedPayloadSchema.parse(block.input) as GeneratedPayload;
  validate(payload, validMonsterIds, validNpcIds, validTileGids, groundLayerGids, objectLayerGids);

  const stamp = Date.now();
  const slug = slugify(payload.encounterTitle).slice(0, 32) || "scene";
  const generatedId = `gen_${stamp}_${slug}`;

  const mapJson = buildMapJson(generatedId, payload);
  const encounterJson = buildEncounterJson(generatedId, payload);

  await mkdir(join(DATA_DIR, "maps"), { recursive: true });
  await mkdir(join(DATA_DIR, "encounters"), { recursive: true });
  await writeFile(join(DATA_DIR, "maps", `${generatedId}.json`), JSON.stringify(mapJson, null, 2));
  await writeFile(join(DATA_DIR, "encounters", `${generatedId}.json`), JSON.stringify(encounterJson, null, 2));

  return { mapId: generatedId, encounterId: generatedId };
}

/**
 * Map-only generator — strips out NPCs, objective, intro / context prose,
 * and just returns a Tiled tile layout. Used by the "Generate Map" button
 * on `GenerateSetupScene`, which lets the player iterate on layouts before
 * committing. Still writes the map JSON to disk so it can be referenced
 * by future encounters.
 */
export async function generateMap(
  anthropic: Anthropic,
  defs: GameDefs,
  req: GenerateRequest,
  disabledTiles: Record<string, number[]> = {},
): Promise<GeneratedMap> {
  const disabledGids = new Set<number>();
  for (const ids of Object.values(disabledTiles)) for (const id of ids) disabledGids.add(id);

  const validTileGids = new Set<number>();
  for (const k of Object.keys(defs.tileLegend.tiles)) {
    const gid = parseInt(k, 10);
    if (disabledGids.has(gid)) continue;
    validTileGids.add(gid);
  }
  const groundLayerGids = layerGidSet(defs, 'ground');
  const objectLayerGids = layerGidSet(defs, 'object');
  for (const gid of disabledGids) { groundLayerGids.delete(gid); objectLayerGids.delete(gid); }

  const system = buildMapSystemPrompt(defs, disabledGids);
  const user = buildUserPrompt(req);
  const tool = buildMapResponseTool();

  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system,
    tools: [tool],
    tool_choice: { type: "tool", name: "submit_map" },
    messages: [{ role: "user", content: user }],
  });

  const block = resp.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Model did not return a tool_use block.");
  const payload = GeneratedMapPayloadSchema.parse(block.input) as GeneratedMapPayload;
  validateMapPayload(payload, validTileGids, groundLayerGids, objectLayerGids);

  const stamp = Date.now();
  const slug = slugify(payload.name).slice(0, 32) || "map";
  const mapId = `gen_${stamp}_${slug}`;

  const mapJson = buildMapJson(mapId, {
    encounterTitle: payload.name,
    description: payload.description,
    mapName: payload.name,
    mapdescription: payload.description,
    objective: "",
    customIntroduction: "",
    customContext: "",
    width: payload.width,
    height: payload.height,
    terrainData: payload.terrainData,
    objectData: payload.objectData,
    startingZonesData: [],
  });

  await mkdir(join(DATA_DIR, "maps"), { recursive: true });
  await writeFile(join(DATA_DIR, "maps", `${mapId}.json`), JSON.stringify(mapJson, null, 2));

  return {
    mapId,
    width: payload.width,
    height: payload.height,
    terrainData: payload.terrainData,
    objectData: payload.objectData,
    name: payload.name,
    description: payload.description,
  };
}

interface GeneratedMapPayload {
  name: string;
  description: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
}

function buildMapSystemPrompt(defs: GameDefs, disabledGids: Set<number> = new Set()): string {
  const legendLines = Object.entries(defs.tileLegend.tiles)
    .filter(([gid]) => !disabledGids.has(parseInt(gid, 10)))
    .map(([gid, t]) => {
      return `  GID ${gid} (${t.name}, ${t.layer}, ${t.passable ? "passable" : "impassable"}): ${t.description}`;
    }).join("\n");
  const setting = settingPromptBlock(defs.activeSetting, 'full');

  return `${setting ? setting + '\n\n' : ''}You are a TILE MAP author for a 2D tile-based RPG. Given a player's free-text description of a PLACE, you produce a Tiled-compatible tile layout. Submit the result via the submit_map tool — no plain-text reply.

YOUR JOB IS ARCHITECTURE, NOT STORY. You do NOT place NPCs, monsters, or any characters. You do NOT write dialogue or quest text. The map is a stage; another step authors who stands on it. If the player's prompt mentions creatures ("two bandits crouch in the rushes"), translate it into spatial features that *imply* the scene (the rushes, the ford) and IGNORE the creatures. Reeds, tents, campfires, broken walls — those go on the map. Bandits, hermits, wolves — those do not.

TILE PALETTE (use only these GIDs, exact integers):
${legendLines}

LAYER MODEL — the map has TWO stacked layers and you must keep them strictly separate:
- \`terrainData\` is the ground layer. Every entry MUST reference a \`layer: "ground"\` GID. No 0s; every cell has a floor.
- \`objectData\` is the object overlay. Entries MUST be 0 (empty) OR a \`layer: "object"\` GID. Never put a ground-layer GID here, and never put an object-layer GID in \`terrainData\`.
- Object-layer GIDs whose name ends in \`_transparent\` have NO floor of their own — place them on top of a varied ground tile (grass, stone_floor, …) to let the floor texture show through. Prefer these for decoration (trees, flowers, crates, …) so the ground variation underneath stays visible.
- A cell is passable iff BOTH its ground tile AND its object tile (if non-zero) are passable.

VARIATION — instead of authoring one floor texture per zone, sprinkle ground variants from the palette so the floor reads as natural surface:
- Outdoor (grass biome): mostly \`grass\` (GID 8) with occasional \`terrain_bumpy\` (99) or \`stone_floor_cracked\` (71).
- Dungeon/indoor: mostly \`stone_floor\` (15) with occasional \`stone_floor_cracked\` (71), \`stone_floor_diamond\` (43), or \`stone_floor_inlay\` (57).
- Then layer transparent-twin objects (flowers 96, tree 110, …) on top.

COMPOSITION — design like a level designer, not a painter:
- Pick a clear focal feature in the centre or off-centre (the courtyard, the hall, the campfire) and arrange other features around it. Avoid uniform fields of one tile.
- Use walls / impassable terrain to shape sightlines and chokepoints. Open clearings should still have edges (tree line, river bank, ruin wall) that give the space definition.
- Doors / archways / bridges go where the prompt implies natural entry — usually the perimeter or between two distinct regions.
- Vary tile choices within a feature: a building's interior floor should differ from the dirt path outside; a campfire should sit on bumpy or cracked ground, not pristine grass.
- Place transparent-twin decoration (flowers, small rocks, single trees) sparingly across passable terrain so the eye lands on the actual gameplay-relevant features rather than busy noise.

MAP RULES:
- Width × height between 12×8 and 30×22 inclusive. Pick a size that fits the described place — a single room is small (12×8 to 14×10); a multi-room layout or outdoor scene goes larger.
- Both arrays must have length exactly width*height, row-major (top row first, left to right).
- The map perimeter (outer ring of cells) should be impassable unless you specifically want creatures to be able to exit off the edge.
- At least one connected region of 24+ passable cells should exist for play to happen in.
- For room-based layouts: build CONNECTED rooms — every room must be reachable from every other via passable corridors or doorways. Never leave a room sealed off.

TONE: gritty, grounded fantasy. Avoid clichés. Match the player's prompt closely.${defs.activeSetting ? `

SETTING-AWARE NAMING — when an active setting block is present at the top of this prompt, the map's \`name\` and \`description\` must read as part of that world. Prefer the setting's place names and glossary terms when they fit; match the setting's tone instead of defaulting to generic high fantasy.` : ''}

NAMING:
- \`name\` is a short 2-4 word PLACE name ("Old Mill Yard", "South Bridge Camp", "Three-Cell Crypt"). Not a scene title or quest name.
- \`description\` is a 1-2 sentence flavour line describing the place. Describe what is THERE — terrain, structures, atmosphere — not what HAPPENS. No characters, no actions, no conflict.`;
}

function buildMapResponseTool() {
  return {
    name: "submit_map",
    description: "Submit the generated map as a structured payload.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        width:  { type: "integer", minimum: 12, maximum: 30 },
        height: { type: "integer", minimum: 8,  maximum: 22 },
        terrainData: { type: "array", items: { type: "integer" } },
        objectData:  { type: "array", items: { type: "integer" } },
      },
      required: ["name", "description", "width", "height", "terrainData", "objectData"],
    },
  };
}

function validateMapPayload(
  p: GeneratedMapPayload,
  validTileGids: Set<number>,
  groundLayerGids: Set<number>,
  objectLayerGids: Set<number>,
): void {
  const cells = p.width * p.height;
  if (p.terrainData.length !== cells) throw new Error(`terrainData length ${p.terrainData.length} ≠ width*height (${cells})`);
  if (p.objectData.length !== cells)  throw new Error(`objectData length ${p.objectData.length} ≠ width*height (${cells})`);
  for (const [i, gid] of p.terrainData.entries()) {
    if (gid === 0) throw new Error(`terrainData[${i}] is 0 (empty) — every terrain cell must reference a valid GID`);
    const base = gid & 0x1fffffff;
    if (!validTileGids.has(base)) throw new Error(`terrainData[${i}] references unknown GID ${base}`);
    if (!groundLayerGids.has(base)) throw new Error(`terrainData[${i}] (GID ${base}) is an object-layer tile — terrainData must contain only ground-layer GIDs`);
  }
  for (const [i, gid] of p.objectData.entries()) {
    if (gid === 0) continue;
    const base = gid & 0x1fffffff;
    if (!validTileGids.has(base)) throw new Error(`objectData[${i}] references unknown GID ${base}`);
    if (!objectLayerGids.has(base)) throw new Error(`objectData[${i}] (GID ${base}) is a ground-layer tile — objectData must contain only object-layer GIDs`);
  }
}

// ── System prompt + user prompt ─────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs, disabledGids: Set<number> = new Set()): string {
  const legendLines = Object.entries(defs.tileLegend.tiles)
    .filter(([gid]) => !disabledGids.has(parseInt(gid, 10)))
    .map(([gid, t]) => {
      return `  GID ${gid} (${t.name}, ${t.layer}, ${t.passable ? "passable" : "impassable"}): ${t.description}`;
    }).join("\n");

  const monsterLines = defs.monsters.map((m) => `  ${m.id} — ${m.name} (CR ${m.cr})`).join("\n");
  const npcLines = defs.npcs.map((n) => `  ${n.id} — ${n.name}`).join("\n");
  const setting = settingPromptBlock(defs.activeSetting, 'full');
  const settingRules = defs.activeSetting ? `

SETTING-AWARE AUTHORING — the active setting block at the top of this prompt is your worldbuilding canon. Every prose field you write (\`encounterTitle\`, \`description\`, \`customIntroduction\`, \`customContext\`, \`objective\`, \`mapName\`, \`mapdescription\`) must read as part of that world, not generic high fantasy. Specifically:
- Match the setting's tone. Where it describes a specific mood (post-collapse, bureaucratic, bleak, etc.), evoke it in prose, NPC behaviour, and stakes — do not default to heroic-quest defaults.
- Use the setting's faction names, place names, and glossary terms naturally whenever they fit the scene. A roadside ambush in a setting with a named imperial highway happens on THAT highway by name.
- Do NOT invent named NPCs, locations, or factions outside the setting. For a generic creature, draw it from the shared monster roster as an unnamed type (\`a bandit\`, \`a wolf\`). For a NAMED character the setting describes, pick a roster id whose stats fit and assign the setting-canonical name via prose (\`customIntroduction\` / \`customContext\`) — the runtime engine never sees the canonical name as an id.
- Treat any "tropes-to-avoid" content in the setting as a hard 'no'. Do not write content that violates it, even if the player's prompt suggests it.
` : '';

  return `${setting ? setting + '\n\n' : ''}You are an encounter author for a 2D tile-based SRD 5.2.1 RPG. Given a player's free-text scene description, you author a complete one-off scenario: a Tiled-compatible tile map AND an encounter definition that references it. Submit the result via the submit_scenario tool — no plain-text reply.${settingRules}

TILE PALETTE (use only these GIDs, exact integers):
${legendLines}

MONSTER ROSTER (use these exact ids in encounter.allyIds / for any combat NPCs the player should fight):
${monsterLines}

NPC ROSTER (use these exact ids in encounter.npcIds for neutral / social NPCs and in encounter.allyIds for friendly companions):
${npcLines}

LAYER MODEL — the map has TWO stacked layers and you must keep them strictly separate:
- \`terrainData\` is the ground layer. Every entry MUST reference a \`layer: "ground"\` GID. No 0s; every cell has a floor.
- \`objectData\` is the object overlay. Entries MUST be 0 (empty) OR a \`layer: "object"\` GID. Never put a ground-layer GID here, and never put an object-layer GID in \`terrainData\`.
- Object-layer GIDs whose name ends in \`_transparent\` have NO floor of their own — place them on top of a varied ground tile (grass, stone_floor, …) so the floor texture shows through underneath. Prefer these for decoration.

VARIATION — sprinkle ground variants from the palette so the floor reads as natural surface (mostly \`grass\` (8) outdoor with occasional \`terrain_bumpy\` (99); mostly \`stone_floor\` (15) indoor with occasional cracked / diamond / inlay variants). Then layer transparent-twin objects (flowers 96, tree 110, crate_transparent 13, …) on top.

MAP RULES:
- Width × height must be between 12×8 and 30×22 inclusive.
- Both arrays must have length exactly width*height, row-major (top row first, left to right).
- A cell is passable iff BOTH its terrain tile and its object tile (if non-zero) are passable.
- Map perimeter should be impassable unless you specifically want the player to be able to exit (used by the flee mechanic).
- At least one connected region of 12+ passable cells must exist for the player and NPCs to occupy.

STARTING ZONES (encounter.startingZones):
- Same width/height as the map.
- Flat data array of zone GIDs (length width*height).
- Zone GIDs: 0 = no zone, 1 = player start, 2 = ally start, 3 = neutral NPC start, 4 = enemy start.
- Only mark passable map tiles as spawn zones.
- AT LEAST ONE tile must be marked "1" (player start). Mark at least one tile per disposition you spawn (zone 2 if you use allyIds; zone 3 if you use npcIds; zone 4 for combat encounters).

ENCOUNTER FIELDS:
- encounterTitle: 2-4 word display title.
- description: 1-2 sentence card blurb.
- mapName: short name shown in the HUD (matches the map's display name).
- mapdescription: short flavour line for the map.
- objective: one-line player-facing goal.
- customIntroduction: 2-3 sentence opening prose in the player's POV (second person, present tense).
- customContext: instructions for the in-game GM — what the scene is about, NPC motivations, escalation paths, and any flags you'd like set on resolution. Mention any completionFlag the GM should set with set_world_flag when the encounter is resolved. When an active setting is present (see top of prompt), OPEN customContext with a single-sentence SETTING CUE that anchors this specific encounter in the world — name the local faction, the recent event, the regional pressure, or the specific stakes the setting implies. The GM uses this cue to ground its first beats; without it the GM falls back to generic medieval-fantasy framing.
- completionFlag: short snake_case string (e.g. "tomb_opened", "diplomat_convinced"). Required when the encounter has no enemies (combat encounters auto-complete on enemy defeat).
- enemyIds: monster ids spawned as hostile combatants. Use for combat scenes.
- npcIds: NPC ids spawned as neutral conversationalists. Use for social scenes.
- allyIds: NPC ids spawned as friendly combatants (fight alongside the player).

TONE: gritty, grounded fantasy. Avoid clichés ("a dark and stormy night"). Match the player's prompt closely.`;
}

function buildUserPrompt(req: GenerateRequest): string {
  const player = req.playerName
    ? `Player character: ${req.playerName}${req.playerClassName ? ` the ${req.playerClassName}` : ""}.\n`
    : "";
  return `${player}\nScene description:\n${req.prompt}\n\nAuthor the scenario now via the submit_scenario tool.`;
}

// ── Anthropic tool schema (structured output) ───────────────────────────────

function buildResponseTool() {
  return {
    name: "submit_scenario",
    description: "Submit the generated map + encounter as a single structured payload.",
    input_schema: {
      type: "object" as const,
      properties: {
        encounterTitle: { type: "string" },
        description: { type: "string" },
        mapName: { type: "string" },
        mapdescription: { type: "string" },
        objective: { type: "string" },
        customIntroduction: { type: "string" },
        customContext: { type: "string" },
        completionFlag: { type: "string" },
        npcIds:   { type: "array", items: { type: "string" } },
        allyIds:  { type: "array", items: { type: "string" } },
        enemyIds: { type: "array", items: { type: "string" } },
        width:  { type: "integer", minimum: 12, maximum: 30 },
        height: { type: "integer", minimum: 8,  maximum: 22 },
        terrainData: { type: "array", items: { type: "integer" } },
        objectData:  { type: "array", items: { type: "integer" } },
        startingZonesData: { type: "array", items: { type: "integer", minimum: 0, maximum: 4 } },
      },
      required: [
        "encounterTitle", "description", "mapName", "mapdescription", "objective",
        "customIntroduction", "customContext",
        "width", "height", "terrainData", "objectData", "startingZonesData",
      ],
    },
  };
}

interface GeneratedPayload {
  encounterTitle: string;
  description: string;
  mapName: string;
  mapdescription: string;
  objective: string;
  customIntroduction: string;
  customContext: string;
  completionFlag?: string;
  npcIds?: string[];
  allyIds?: string[];
  enemyIds?: string[];
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  startingZonesData: number[];
}

// ── Validation ──────────────────────────────────────────────────────────────

function validate(
  p: GeneratedPayload,
  validMonsterIds: Set<string>,
  validNpcIds: Set<string>,
  validTileGids: Set<number>,
  groundLayerGids: Set<number>,
  objectLayerGids: Set<number>,
): void {
  const cells = p.width * p.height;
  if (p.terrainData.length !== cells) throw new Error(`terrainData length ${p.terrainData.length} ≠ width*height (${cells})`);
  if (p.objectData.length !== cells)  throw new Error(`objectData length ${p.objectData.length} ≠ width*height (${cells})`);
  if (p.startingZonesData.length !== cells) throw new Error(`startingZonesData length ${p.startingZonesData.length} ≠ width*height (${cells})`);

  for (const [i, gid] of p.terrainData.entries()) {
    if (gid === 0) throw new Error(`terrainData[${i}] is 0 (empty) — every terrain cell must reference a valid GID`);
    const base = gid & 0x1fffffff;
    if (!validTileGids.has(base)) throw new Error(`terrainData[${i}] references unknown GID ${base}`);
    if (!groundLayerGids.has(base)) throw new Error(`terrainData[${i}] (GID ${base}) is an object-layer tile — terrainData must contain only ground-layer GIDs`);
  }
  for (const [i, gid] of p.objectData.entries()) {
    if (gid === 0) continue;
    const base = gid & 0x1fffffff;
    if (!validTileGids.has(base)) throw new Error(`objectData[${i}] references unknown GID ${base}`);
    if (!objectLayerGids.has(base)) throw new Error(`objectData[${i}] (GID ${base}) is a ground-layer tile — objectData must contain only object-layer GIDs`);
  }

  const playerZoneCount = p.startingZonesData.filter((z) => z === 1).length;
  if (playerZoneCount === 0) throw new Error("startingZonesData has no player-spawn (zone 1) tiles");

  // Combine NPC + ally + enemy id validation against both rosters.
  const allReferencedIds = [...(p.npcIds ?? []), ...(p.allyIds ?? []), ...(p.enemyIds ?? [])];
  for (const id of allReferencedIds) {
    if (!validNpcIds.has(id) && !validMonsterIds.has(id)) {
      throw new Error(`Unknown NPC id "${id}" — not in npcs/ or monsters/`);
    }
  }

  // Non-combat encounters (no hand-picked enemies) must declare a completionFlag
  // since they can't auto-complete on enemy defeat.
  if ((p.enemyIds ?? []).length === 0 && !p.completionFlag) {
    throw new Error("Non-combat encounters must declare a completionFlag");
  }
}

// ── File-shape builders ─────────────────────────────────────────────────────

function buildMapJson(id: string, p: GeneratedPayload): unknown {
  // Delegates to the shared `MapPersistence.buildMapJson` for the Tiled-shape
  // layout. The generator's `GeneratedPayload` carries both map and encounter
  // fields; only the map subset matters here.
  return sharedBuildMapJson({
    id,
    name: p.mapName,
    description: p.mapdescription,
    width: p.width,
    height: p.height,
    terrainData: p.terrainData,
    objectData: p.objectData,
  });
}

function buildEncounterJson(id: string, p: GeneratedPayload): unknown {
  return {
    id,
    encounterTitle: p.encounterTitle,
    description: p.description,
    mapId: id,
    npcIds: p.npcIds ?? [],
    allyIds: p.allyIds ?? [],
    enemyIds: p.enemyIds ?? [],
    customIntroduction: p.customIntroduction,
    customContext: p.customContext,
    objective: p.objective,
    completionFlag: p.completionFlag,
    generated: true,
    startingZones: {
      width: p.width,
      height: p.height,
      data: p.startingZonesData,
    },
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function layerGidSet(defs: GameDefs, layer: 'ground' | 'object'): Set<number> {
  const out = new Set<number>();
  for (const [gid, t] of Object.entries(defs.tileLegend.tiles)) {
    if (t.layer === layer) out.add(parseInt(gid, 10));
  }
  return out;
}
