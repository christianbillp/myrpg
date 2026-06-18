import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { GameDefs } from "./engine/types.js";
import { buildMapJson as sharedBuildMapJson } from "./engine/MapPersistence.js";
import { AI_PALETTE_TILESETS, tilesetsForGids, ownerTilesetName } from "./engine/maps/shared.js";
import { composeRegionsWithExtras, FEATURE_IDS } from "./engine/MapComposer.js";
import type { ComposedMap } from "./engine/mapTypes.js";
import { settingPromptBlock } from "./settings.js";
import { safeId } from "./util/requestValidation.js";

/** zod schema for the tool-output payload Claude returns. The parsed result is
 *  narrowed back to the inferred interface so the rest of the file keeps using
 *  the same name. A schema mismatch surfaces as a clear `ZodError` at the call
 *  site instead of a downstream undefined-field crash during validation. */
const RegionPlanSchema = z.object({
  width:  z.number().int(),
  height: z.number().int(),
  regions: z.array(z.object({
    terrain: z.enum(['grassland', 'forest', 'urban', 'cave', 'dungeon']),
    share:   z.number().optional(),
    name:    z.string().optional(),
    light:   z.enum(['bright', 'dim', 'dark']).optional(),
  })).min(2).max(5),
  playerRegion:   z.number().int().optional(),
  hostileRegions: z.array(z.number().int()).optional(),
  neutralRegions: z.array(z.number().int()).optional(),
  allyRegions:    z.array(z.number().int()).optional(),
  /** Structures to STAMP onto the bands (Phase B) — the engine places each one
   *  consciously (connected, never overlapping roads/each other) and re-rolls
   *  until it fits. Far better than hand-painting buildings into tile arrays. */
  structures:     z.array(z.object({
    id:     z.string(),
    rooms:  z.number().int().optional(),
    region: z.number().int().optional(),
  })).optional(),
  /** Roads laid across the open bands. */
  roads:          z.array(z.enum(['path', 'intersection'])).optional(),
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
  width:              z.number().int().optional(),
  height:             z.number().int().optional(),
  terrainData:        z.array(z.number()).optional(),
  objectData:         z.array(z.number()).optional(),
  startingZonesData:  z.array(z.number()).optional(),
  /** Big multi-region map mode (US-126 + Phase B): the model plans biome bands
   *  (+ optional stamped structures and roads) instead of authoring tiles;
   *  `composeRegionsWithExtras` synthesizes the map. Exactly one of regionPlan /
   *  the direct tile arrays must be present. */
  regionPlan:         RegionPlanSchema.optional(),
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
  const legend = globalTileLegend(defs);
  const validTileGids = new Set<number>(legend.map((t) => t.gid));
  const groundLayerGids = layerGidSet(legend, 'ground');
  const objectLayerGids = layerGidSet(legend, 'object');

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
  const payload = GeneratedPayloadSchema.parse(block.input) as GeneratedPayload;
  validateCommon(payload, validMonsterIds, validNpcIds);

  const stamp = Date.now();
  const slug = slugify(payload.encounterTitle).slice(0, 32) || "scene";
  const generatedId = safeId(`gen_${stamp}_${slug}`);

  let mapJson: unknown;
  let encounterJson: unknown;
  if (payload.regionPlan) {
    // Multi-region big map (US-126): synthesize the tiles deterministically
    // from the model's biome plan, then derive spawn zones from the
    // per-region map zones the composer emitted.
    const plan = payload.regionPlan;
    const composed = composeRegionsWithExtras({
      width: plan.width,
      height: plan.height,
      seed: stamp & 0xffffffff,
      regions: plan.regions,
      placeables: plan.structures,
      features: plan.roads,
    });
    const startingZonesData = buildRegionStartingZones(composed, plan, legend);
    mapJson = sharedBuildMapJson({
      id: generatedId,
      name: payload.mapName,
      description: payload.mapdescription,
      width: composed.width,
      height: composed.height,
      terrainData: composed.terrainData,
      objectData: composed.objectData,
      tilesets: composed.tilesets,
      zones: composed.zones,
    });
    encounterJson = buildEncounterJson(generatedId, payload, {
      width: composed.width,
      height: composed.height,
      data: startingZonesData,
    });
  } else {
    validateDirectMap(payload, validTileGids, groundLayerGids, objectLayerGids);
    mapJson = buildMapJson(generatedId, payload as DirectMapPayload);
    encounterJson = buildEncounterJson(generatedId, payload, {
      width: payload.width!,
      height: payload.height!,
      data: payload.startingZonesData!,
    });
  }

  await mkdir(join(DATA_DIR, "maps"), { recursive: true });
  await mkdir(join(DATA_DIR, "encounters"), { recursive: true });
  await writeFile(join(DATA_DIR, "maps", `${generatedId}.json`), JSON.stringify(mapJson, null, 2));
  await writeFile(join(DATA_DIR, "encounters", `${generatedId}.json`), JSON.stringify(encounterJson, null, 2));

  return { mapId: generatedId, encounterId: generatedId };
}

// ── System prompt + user prompt ─────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs): string {
  const legendText = legendLines(globalTileLegend(defs));

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
${legendText}

MONSTER ROSTER (use these exact ids in encounter.allyIds / for any combat NPCs the player should fight):
${monsterLines}

NPC ROSTER (use these exact ids in encounter.npcIds for neutral / social NPCs and in encounter.allyIds for friendly companions):
${npcLines}

LAYER MODEL — the map has TWO stacked layers and you must keep them strictly separate:
- \`terrainData\` is the ground layer. Every entry MUST reference a \`layer: "ground"\` GID. No 0s; every cell has a floor.
- \`objectData\` is the object overlay. Entries MUST be 0 (empty) OR a \`layer: "object"\` GID. Never put a ground-layer GID here, and never put an object-layer GID in \`terrainData\`.
- Object-layer GIDs whose name ends in \`_transparent\` have NO floor of their own — place them on top of a varied ground tile (grass, stone_floor, …) so the floor texture shows through underneath. Prefer these for decoration.

VARIATION — sprinkle ground variants from the palette so the floor reads as natural surface (mostly \`grass\` (8) outdoor with occasional \`terrain_bumpy\` (99); mostly \`stone_floor\` (15) indoor with occasional cracked / diamond / inlay variants). Then layer transparent-twin objects (flowers 96, tree 110, crate_transparent 13, …) on top.

BIOME FLOORS — for caverns and settlements, prefer the themed floor families in the palette over the default scribble floors: the cave floors (cave_dust / cave_gravel / cave_rocky, plus impassable cave_pool water and sight-blocking chasm pits) for underground scenes, and the urban floors (urban_cobbles / urban_bricks / urban_large_slabs / plazas) for paved streets, courtyards, and interiors. Pick ONE primary floor family per region and accent with scribble objects on top.

TWO MAP MODES — pick exactly one:
1. DIRECT (default, single-scene maps up to 30×22): author the tile arrays yourself per MAP RULES below.
2. REGION PLAN (big multi-biome maps, 24×16 up to 96×64): when the scene calls for a JOURNEY across changing terrain — "a grassland that becomes a forest and ends in a cave", "the road through the wood to the mine" — submit \`regionPlan\` INSTEAD of width/height/terrainData/objectData/startingZonesData. List 2-5 regions in travel order; the engine lays them out as bands with natural blended transitions (open biomes) or a carved rock-face mouth (cave/dungeon regions), names a map zone per region, makes cave/dungeon regions genuinely dark, and guarantees connectivity. Give regions evocative zone names, put the player in the entry region (\`playerRegion\`), and assign \`hostileRegions\` so different creatures hold different regions (goblins in the forest, undead in the cave). Spawn zones are derived for you — do NOT send tile arrays in this mode.

STRUCTURES (region-plan mode) — DECLARE buildings & landmarks; do not paint them. If the scene has a tavern, a watchtower, a ruined keep, a graveyard, a town square, or any building, add it to \`regionPlan.structures\` with a type from {building, ruin, tavern, watchtower, cemetery, town_square, shrine, farmstead, mine, bandit_hideout} (building/ruin/tavern take \`rooms\` 1-5 — a tavern with more rooms gains a kitchen, cellar, snug, etc. around its taproom; the rest are fixed-size set-pieces). Optionally pin one to a \`region\` index (a building belongs in an OPEN band, never a cave). The engine stamps each one fully-walled, furnished, and connected, placed clear of roads and each other — far more reliable than authoring wall tiles by hand. Add \`roads: ["path"]\` (or "intersection") to lay a winding road across the open bands.

MAP RULES (direct mode):
- Width × height must be between 12×8 and 30×22 inclusive.
- Both arrays must have length exactly width*height, row-major (top row first, left to right).
- A cell is passable iff BOTH its terrain tile and its object tile (if non-zero) are passable.
- Map perimeter should be impassable unless you specifically want the player to be able to exit (used by the flee mechanic).
- At least one connected region of 12+ passable cells must exist for the player and NPCs to occupy.

STARTING ZONES (encounter.startingZones — direct mode only; region-plan maps derive these):
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
        width:  { type: "integer", minimum: 12, maximum: 30, description: "Direct map mode only." },
        height: { type: "integer", minimum: 8,  maximum: 22, description: "Direct map mode only." },
        terrainData: { type: "array", items: { type: "integer" }, description: "Direct map mode only." },
        objectData:  { type: "array", items: { type: "integer" }, description: "Direct map mode only." },
        startingZonesData: { type: "array", items: { type: "integer", minimum: 0, maximum: 4 }, description: "Direct map mode only." },
        regionPlan: {
          type: "object",
          description: "BIG MULTI-REGION MAP MODE — provide this INSTEAD of width/height/terrainData/objectData/startingZonesData. The engine synthesizes the tiles from your biome plan.",
          properties: {
            width:  { type: "integer", minimum: 24, maximum: 96 },
            height: { type: "integer", minimum: 16, maximum: 64 },
            regions: {
              type: "array",
              minItems: 2,
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  terrain: { type: "string", enum: ["grassland", "forest", "urban", "cave", "dungeon"] },
                  share:   { type: "number", description: "Relative share of the map's long axis (default 1)." },
                  name:    { type: "string", description: "Zone display name (e.g. 'the Wardwood')." },
                  light:   { type: "string", enum: ["bright", "dim", "dark"], description: "Ambient light in this region. Cave/dungeon default to dark." },
                },
                required: ["terrain"],
              },
            },
            playerRegion:   { type: "integer", description: "Region index (0-based) where the player starts. Default 0." },
            hostileRegions: { type: "array", items: { type: "integer" }, description: "Region indexes that get enemy spawn zones. Default: every region except the player's." },
            neutralRegions: { type: "array", items: { type: "integer" }, description: "Region indexes that get neutral-NPC spawn zones." },
            allyRegions:    { type: "array", items: { type: "integer" }, description: "Region indexes that get ally spawn zones. Default: the player's region." },
            structures: {
              type: "array",
              description: "STRUCTURES to stamp onto the bands — declare them here rather than hand-painting buildings. The engine places each consciously (connected, never overlapping a road or another structure) and re-rolls until it fits. Use for any building/landmark in the scene.",
              items: {
                type: "object",
                properties: {
                  id:     { type: "string", enum: [...FEATURE_IDS], description: "Structure type. building/ruin/tavern take a room count; the rest are fixed-size set-pieces." },
                  rooms:  { type: "integer", minimum: 1, maximum: 5, description: "Room count for building/ruin/tavern (ignored by set-pieces)." },
                  region: { type: "integer", description: "Optional: region index to place it in (defaults to anywhere open; a cave/dungeon band has no room for a building)." },
                },
                required: ["id"],
              },
            },
            roads: { type: "array", items: { type: "string", enum: ["path", "intersection"] }, description: "Lay a winding road across the open bands ('intersection' = a crossroads)." },
          },
          required: ["width", "height", "regions"],
        },
      },
      required: [
        "encounterTitle", "description", "mapName", "mapdescription", "objective",
        "customIntroduction", "customContext",
      ],
    },
  };
}

type RegionPlan = z.infer<typeof RegionPlanSchema>;

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
  width?: number;
  height?: number;
  terrainData?: number[];
  objectData?: number[];
  startingZonesData?: number[];
  regionPlan?: RegionPlan;
}

/** Direct-map mode payload — the five tile fields verified present. */
type DirectMapPayload = GeneratedPayload & {
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  startingZonesData: number[];
};

// ── Validation ──────────────────────────────────────────────────────────────

/** Mode-independent checks: roster ids + the completion-flag rule, plus the
 *  exactly-one-map-mode invariant. */
function validateCommon(
  p: GeneratedPayload,
  validMonsterIds: Set<string>,
  validNpcIds: Set<string>,
): void {
  const hasDirect = !!p.terrainData || !!p.objectData || !!p.startingZonesData;
  if (p.regionPlan && hasDirect) throw new Error("Provide either regionPlan OR the direct tile arrays — not both");
  if (!p.regionPlan && !hasDirect) throw new Error("Provide regionPlan or the direct tile arrays");
  if (p.regionPlan) {
    const { width, height, regions } = p.regionPlan;
    if (width < 24 || width > 96 || height < 16 || height > 64) {
      throw new Error(`regionPlan size ${width}×${height} out of range (24×16 to 96×64)`);
    }
    const max = regions.length;
    for (const idx of [p.regionPlan.playerRegion ?? 0, ...(p.regionPlan.hostileRegions ?? []), ...(p.regionPlan.neutralRegions ?? []), ...(p.regionPlan.allyRegions ?? [])]) {
      if (idx < 0 || idx >= max) throw new Error(`regionPlan references region index ${idx}, but only ${max} regions are declared`);
    }
    for (const s of p.regionPlan.structures ?? []) {
      if (!FEATURE_IDS.includes(s.id)) throw new Error(`regionPlan structure "${s.id}" is not one of ${FEATURE_IDS.join(', ')}`);
      if (s.region !== undefined && (s.region < 0 || s.region >= max)) throw new Error(`regionPlan structure targets region ${s.region}, but only ${max} regions are declared`);
    }
  }

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

/** Direct-tile-mode checks — every GID validated against the live legend. */
function validateDirectMap(
  p: GeneratedPayload,
  validTileGids: Set<number>,
  groundLayerGids: Set<number>,
  objectLayerGids: Set<number>,
): asserts p is DirectMapPayload {
  if (p.width === undefined || p.height === undefined || !p.terrainData || !p.objectData || !p.startingZonesData) {
    throw new Error("Direct map mode requires width, height, terrainData, objectData, and startingZonesData");
  }
  if (p.width < 12 || p.width > 30 || p.height < 8 || p.height > 22) {
    throw new Error(`Direct map size ${p.width}×${p.height} out of range (12×8 to 30×22) — use regionPlan for bigger maps`);
  }
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
}

/**
 * Derive `startingZones` data for a composed multi-region map: the player
 * spawns near the centroid of their region, hostiles/neutrals/allies get a
 * spread of passable cells across each assigned region's zone. Passability
 * is resolved from the same global tile legend the validators use.
 */
function buildRegionStartingZones(composed: ComposedMap, plan: RegionPlan, legend: GlobalTile[]): number[] {
  const blocks = new Map<number, boolean>();
  for (const t of legend) blocks.set(t.gid, t.blocksMovement);
  const W = composed.width;
  const passable = (x: number, y: number): boolean => {
    const i = y * W + x;
    const ground = composed.terrainData[i] & 0x1fffffff;
    const obj = composed.objectData[i] & 0x1fffffff;
    if (ground === 0 || (blocks.get(ground) ?? true)) return false;
    return obj === 0 || !(blocks.get(obj) ?? true);
  };
  const regionZones = composed.zones ?? [];
  const cellsOf = (regionIdx: number): Array<{ x: number; y: number }> => {
    const zone = regionZones[regionIdx];
    if (!zone) return [];
    return zone.cells
      .map((cell) => { const [x, y] = cell.split(',').map(Number); return { x, y }; })
      .filter((p) => passable(p.x, p.y));
  };

  const data = new Array<number>(W * composed.height).fill(0);
  const mark = (regionIdx: number, code: number, count: number, nearCentroid: boolean): void => {
    const cells = cellsOf(regionIdx);
    if (cells.length === 0) return;
    if (nearCentroid) {
      const cx = cells.reduce((s, p) => s + p.x, 0) / cells.length;
      const cy = cells.reduce((s, p) => s + p.y, 0) / cells.length;
      cells.sort((a, b) => (Math.abs(a.x - cx) + Math.abs(a.y - cy)) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)));
      for (const p of cells.slice(0, count)) data[p.y * W + p.x] = code;
      return;
    }
    // Spread: take evenly-spaced cells across the zone so a region's spawns
    // aren't all bunched in one corner.
    const step = Math.max(1, Math.floor(cells.length / count));
    for (let i = 0, marked = 0; i < cells.length && marked < count; i += step, marked++) {
      const p = cells[i];
      if (data[p.y * W + p.x] === 0) data[p.y * W + p.x] = code;
    }
  };

  mark(plan.playerRegion ?? 0, 1, 5, true);
  for (const r of plan.allyRegions ?? [plan.playerRegion ?? 0]) mark(r, 2, 4, true);
  for (const r of plan.neutralRegions ?? []) mark(r, 3, 6, false);
  const hostiles = plan.hostileRegions ?? composed.zones?.map((_, i) => i).filter((i) => i !== (plan.playerRegion ?? 0)) ?? [];
  for (const r of hostiles) mark(r, 4, 8, false);
  return data;
}

// ── File-shape builders ─────────────────────────────────────────────────────

function buildMapJson(id: string, p: DirectMapPayload): unknown {
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
    tilesets: tilesetsForGids([...p.terrainData, ...p.objectData]),
  });
}

function buildEncounterJson(
  id: string,
  p: GeneratedPayload,
  startingZones: { width: number; height: number; data: number[] },
): unknown {
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
    startingZones,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * A single tile as the AI generator sees it: its GLOBAL gid (firstgid offset
 * applied) plus the legend fields the prompt and validators need.
 */
interface GlobalTile {
  gid: number;
  name: string;
  layer: 'ground' | 'object';
  blocksMovement: boolean;
  blocksSight: boolean;
  description: string;
}

/**
 * Flatten every AI-palette tileset's per-tileset legend into one list keyed by
 * GLOBAL gid (firstgid + local id − 1). Unlike the merged `defs.tileLegend`
 * (keyed by local id, so scribble shadows water/cave at the same low ids),
 * this disambiguates tilesets so all three coexist in the prompt and pass
 * validation. SessionBuilder resolves the same global gids back at play time.
 */
function globalTileLegend(defs: GameDefs): GlobalTile[] {
  const out: GlobalTile[] = [];
  for (const { name, ref } of AI_PALETTE_TILESETS) {
    const tiles = defs.tileLegendsByTileset[name];
    if (!tiles) continue;
    for (const [localKey, t] of Object.entries(tiles)) {
      const gid = ref.firstgid + (parseInt(localKey, 10) - 1);
      // Only offer a gid this tileset genuinely owns. Drops scribble's high
      // void sentinel (65534), which sits above water/cave firstgids and would
      // otherwise mis-route to them at play time. The AI uses chasm tiles for
      // pits instead.
      if (ownerTilesetName(gid) !== name) continue;
      out.push({
        gid,
        name: t.name,
        layer: t.layer,
        blocksMovement: t.blocksMovement,
        blocksSight: t.blocksSight,
        description: t.description,
      });
    }
  }
  return out.sort((a, b) => a.gid - b.gid);
}

function legendLines(legend: GlobalTile[]): string {
  return legend
    .map((t) => `  GID ${t.gid} (${t.name}, ${t.layer}, ${t.blocksMovement ? "impassable" : "passable"}${t.blocksSight ? ", blocks sight" : ""}): ${t.description}`)
    .join("\n");
}

function layerGidSet(legend: GlobalTile[], layer: 'ground' | 'object'): Set<number> {
  const out = new Set<number>();
  for (const t of legend) if (t.layer === layer) out.add(t.gid);
  return out;
}
