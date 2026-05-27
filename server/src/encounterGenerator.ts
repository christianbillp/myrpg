import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { GameDefs } from "./engine/types.js";
import { buildMapJson as sharedBuildMapJson } from "./engine/MapPersistence.js";

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
): Promise<GeneratedScenario> {
  const validMonsterIds = new Set(defs.monsters.map((m) => m.id));
  const validNpcIds = new Set(defs.npcs.map((n) => n.id));
  const validTileGids = new Set(Object.keys(defs.tileLegend.tiles).map((k) => parseInt(k, 10)));

  const system = buildSystemPrompt(defs);
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
  const payload = block.input as unknown as GeneratedPayload;
  validate(payload, validMonsterIds, validNpcIds, validTileGids);

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
): Promise<GeneratedMap> {
  const validTileGids = new Set(Object.keys(defs.tileLegend.tiles).map((k) => parseInt(k, 10)));

  const system = buildMapSystemPrompt(defs);
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
  const payload = block.input as unknown as GeneratedMapPayload;
  validateMapPayload(payload, validTileGids);

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

function buildMapSystemPrompt(defs: GameDefs): string {
  const legendLines = Object.entries(defs.tileLegend.tiles).map(([gid, t]) => {
    return `  GID ${gid} (${t.name}, ${t.layer}, ${t.passable ? "passable" : "impassable"}): ${t.description}`;
  }).join("\n");

  return `You are a map author for a 2D tile-based RPG. Given a player's free-text scene description, you author a Tiled-compatible tile map. Submit the result via the submit_map tool — no plain-text reply.

TILE PALETTE (use only these GIDs, exact integers):
${legendLines}

MAP RULES:
- Width × height between 12×8 and 30×22 inclusive.
- Both arrays must have length exactly width*height, row-major (top row first, left to right).
- The terrain array must have a non-zero passable GID at every walkable cell — and every cell must have SOME terrain GID (no 0s in terrain).
- Index 0 in the object array means "empty"; non-zero entries must reference an "object" layer GID from the palette above.
- The map perimeter (outer ring of cells) should be impassable unless you specifically want creatures to be able to exit off the edge.
- At least one connected region of 24+ passable cells should exist for play to happen in.

TONE: gritty, grounded fantasy. Avoid clichés. Match the player's prompt closely.

NAMING: \`name\` is a short 2-4 word title; \`description\` is a 1-2 sentence flavour line for the map.`;
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

function validateMapPayload(p: GeneratedMapPayload, validTileGids: Set<number>): void {
  const cells = p.width * p.height;
  if (p.terrainData.length !== cells) throw new Error(`terrainData length ${p.terrainData.length} ≠ width*height (${cells})`);
  if (p.objectData.length !== cells)  throw new Error(`objectData length ${p.objectData.length} ≠ width*height (${cells})`);
  for (const [i, gid] of p.terrainData.entries()) {
    if (gid === 0) throw new Error(`terrainData[${i}] is 0 (empty) — every terrain cell must reference a valid GID`);
    if (!validTileGids.has(gid)) throw new Error(`terrainData[${i}] references unknown GID ${gid}`);
  }
  for (const [i, gid] of p.objectData.entries()) {
    if (gid !== 0 && !validTileGids.has(gid)) throw new Error(`objectData[${i}] references unknown GID ${gid}`);
  }
}

// ── System prompt + user prompt ─────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs): string {
  const legendLines = Object.entries(defs.tileLegend.tiles).map(([gid, t]) => {
    return `  GID ${gid} (${t.name}, ${t.layer}, ${t.passable ? "passable" : "impassable"}): ${t.description}`;
  }).join("\n");

  const monsterLines = defs.monsters.map((m) => `  ${m.id} — ${m.name} (CR ${m.cr})`).join("\n");
  const npcLines = defs.npcs.map((n) => `  ${n.id} — ${n.name}`).join("\n");

  return `You are an encounter author for a 2D tile-based D&D 5e SRD RPG. Given a player's free-text scene description, you author a complete one-off scenario: a Tiled-compatible tile map AND an encounter definition that references it. Submit the result via the submit_scenario tool — no plain-text reply.

TILE PALETTE (use only these GIDs, exact integers):
${legendLines}

MONSTER ROSTER (use these exact ids in encounter.allyIds / for any combat NPCs the player should fight):
${monsterLines}

NPC ROSTER (use these exact ids in encounter.npcIds for neutral / social NPCs and in encounter.allyIds for friendly companions):
${npcLines}

MAP RULES:
- Width × height must be between 12×8 and 30×22 inclusive.
- Both arrays must have length exactly width*height, row-major (top row first, left to right).
- Index 0 means "empty" for the objects layer; the terrain layer must always have a non-zero passable GID at every walkable cell.
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
- customContext: instructions for the in-game GM — what the scene is about, NPC motivations, escalation paths, and any flags you'd like set on resolution. Mention any completionFlag the GM should set with set_world_flag when the encounter is resolved.
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
): void {
  const cells = p.width * p.height;
  if (p.terrainData.length !== cells) throw new Error(`terrainData length ${p.terrainData.length} ≠ width*height (${cells})`);
  if (p.objectData.length !== cells)  throw new Error(`objectData length ${p.objectData.length} ≠ width*height (${cells})`);
  if (p.startingZonesData.length !== cells) throw new Error(`startingZonesData length ${p.startingZonesData.length} ≠ width*height (${cells})`);

  for (const [i, gid] of p.terrainData.entries()) {
    if (gid === 0) throw new Error(`terrainData[${i}] is 0 (empty) — every terrain cell must reference a valid GID`);
    if (!validTileGids.has(gid)) throw new Error(`terrainData[${i}] references unknown GID ${gid}`);
  }
  for (const [i, gid] of p.objectData.entries()) {
    if (gid !== 0 && !validTileGids.has(gid)) throw new Error(`objectData[${i}] references unknown GID ${gid}`);
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
