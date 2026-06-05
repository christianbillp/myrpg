/**
 * Agentic map generator — the replacement for the one-shot "emit a raw tile
 * array" generator. Instead of asking the model for GIDs, it exposes the
 * deterministic op toolbox (`mapOps`) as Anthropic tools and lets the model
 * DIRECT the build: it calls operations (stamp a room here, carve a corridor,
 * lay a path, flood an edge with water), and after every step the server sends
 * back an ASCII render of the canvas so the model can see its work and correct
 * course. The ops guarantee valid geometry (aligned walls, connected corridors,
 * auto-tiled paths/water), so the model never produces a broken map.
 *
 * When the model calls `finish`, the canvas is validated for connectivity and
 * auto-repaired (disconnected passable regions are joined with corridors)
 * before the map is persisted.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { GameDefs } from '../types.js';
import type { ComposedMap } from '../mapTypes.js';
import { settingPromptBlock } from '../../settings.js';
import { safeId } from '../../util/requestValidation.js';
import { buildMapJson } from '../MapPersistence.js';
import { MapCanvas } from './MapCanvas.js';
import { renderCanvasAscii } from './canvasRender.js';
import { MATERIAL_NAMES, GROUND_MATERIALS } from './materials.js';
import {
  fillTerrain, stampRoom, placeBuilding, carveCorridor, layPath, placeWaterBody,
  placeHazard, scatterDecor, placeCampsite, paintRegion, defineZone, wallAroundFloor,
  validateCanvas, passableRegions, type OpResult,
} from './mapOps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');

const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 30;     // model round-trips
const MAX_OPS = 80;       // total operations across the build
const MIN_W = 12, MAX_W = 40, MIN_H = 8, MAX_H = 30;

export interface AgenticMapRequest { prompt: string; }
export interface GeneratedMap {
  mapId: string;
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
}

// ── Tool schemas ─────────────────────────────────────────────────────────────

const POINT = { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } as const;
const RECT = { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } }, required: ['x', 'y', 'w', 'h'] } as const;

function buildTools(): Anthropic.Tool[] {
  const ground = MATERIAL_NAMES.ground as unknown as string[];
  const hazard = MATERIAL_NAMES.hazard as unknown as string[];
  return [
    {
      name: 'begin_map',
      description: 'MUST be called first. Create the canvas at the chosen size and lay the base ground. Pick a size that fits the place (a single room ~14×10; an outdoor scene or multi-room layout larger).',
      input_schema: {
        type: 'object',
        properties: {
          width: { type: 'integer', minimum: MIN_W, maximum: MAX_W },
          height: { type: 'integer', minimum: MIN_H, maximum: MAX_H },
          baseTerrain: { type: 'string', enum: ['void', 'grassland', 'forest', 'dungeon', 'cave', 'urban', ...ground], description: '"void" = empty (carve floors yourself, for caves/dungeons); a biome (grassland/forest/dungeon/cave/urban) = varied palette fill; or a flat ground material.' },
          name: { type: 'string', description: 'Short 2-4 word place name.' },
          description: { type: 'string', description: '1-2 sentence flavour line describing what is THERE.' },
        },
        required: ['width', 'height', 'baseTerrain', 'name', 'description'],
      },
    },
    { name: 'stamp_room', description: 'Stamp a rectangular walled room: floor fill + aligned wall ring + carved doorways. Doorways must sit on the wall ring.', input_schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, floor: { type: 'string', enum: ground }, doorways: { type: 'array', items: POINT }, walls: { type: 'boolean' }, zoneName: { type: 'string' } }, required: ['x', 'y', 'w', 'h', 'floor'] } },
    { name: 'place_building', description: 'Stone-floored walled building with one auto-placed doorway on the chosen side.', input_schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, doorSide: { type: 'string', enum: ['N', 'S', 'E', 'W'] }, floor: { type: 'string', enum: ground }, name: { type: 'string' } }, required: ['x', 'y', 'w', 'h'] } },
    { name: 'carve_corridor', description: 'Carve an L-shaped floor corridor between two points, punching through any walls so it always connects.', input_schema: { type: 'object', properties: { from: POINT, to: POINT, width: { type: 'integer', enum: [1, 2] }, floor: { type: 'string', enum: ground } }, required: ['from', 'to', 'floor'] } },
    { name: 'lay_path', description: 'Lay an auto-tiled dirt path on the object layer through a list of waypoints (connected by L segments). Good for roads/trails over open ground.', input_schema: { type: 'object', properties: { waypoints: { type: 'array', items: POINT, minItems: 2 } }, required: ['waypoints'] } },
    { name: 'place_water', description: 'Place water: mode "edge" floods a map edge (a coast); mode "pond" fills a rectangle as a shored pond. Water is impassable — bridge it with a path or corridor to cross.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['edge', 'pond'] }, side: { type: 'string', enum: ['N', 'S', 'E', 'W'] }, depth: { type: 'integer' }, rect: RECT }, required: ['mode'] } },
    { name: 'place_hazard', description: 'Paint impassable hazard ground (pools, chasms) as a tactical obstacle. Chasms also block line of sight.', input_schema: { type: 'object', properties: { rect: RECT, cells: { type: 'array', items: POINT }, material: { type: 'string', enum: hazard } }, required: ['material'] } },
    { name: 'scatter_decor', description: 'Sprinkle clustered biome decoration (trees/flowers) over untouched natural ground in a region (default whole map). Call near the end so structures stay clear.', input_schema: { type: 'object', properties: { biome: { type: 'string', enum: ['grassland', 'forest', 'dungeon'] }, rect: RECT }, required: ['biome'] } },
    { name: 'place_campsite', description: 'Drop a campfire with flanking firewood and a crate at a point on open ground.', input_schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'] } },
    { name: 'paint_region', description: 'Low-level: paint a single material onto a rect/cells on the given layer. Use when no higher-level op fits.', input_schema: { type: 'object', properties: { rect: RECT, cells: { type: 'array', items: POINT }, material: { type: 'string' }, layer: { type: 'string', enum: ['ground', 'object'] } }, required: ['material', 'layer'] } },
    { name: 'wall_around_floor', description: 'Wrap every void cell touching floor with correctly-rotated walls. Use after carving an organic cave floor to enclose it.', input_schema: { type: 'object', properties: {} } },
    { name: 'define_zone', description: 'Tag a region with an author-time named zone (e.g. "ambush", "high ground", "entrance") for the encounter layer. Paints nothing.', input_schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' }, rect: RECT, cells: { type: 'array', items: POINT } }, required: ['name'] } },
    { name: 'finish', description: 'Call when the map is complete. The server validates connectivity and persists the map. Provide the final name + description.', input_schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] } },
  ];
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

interface Dispatch { canvas: MapCanvas | null; name: string; description: string; }

function applyTool(state: Dispatch, name: string, input: Record<string, unknown>): { text: string; isError: boolean; done: boolean } {
  if (name === 'begin_map') {
    if (state.canvas) return { text: 'begin_map already called; the canvas exists. Continue building.', isError: true, done: false };
    const width = clamp(input.width as number, MIN_W, MAX_W);
    const height = clamp(input.height as number, MIN_H, MAX_H);
    const canvas = new MapCanvas({ width, height, seed: deriveSeed(state.name, width, height) });
    const base = String(input.baseTerrain);
    if (base !== 'void') {
      // Try a biome palette first (varied fill); fall back to a flat material.
      let res = fillTerrain(canvas, { biome: base as never });
      if (!res.ok) res = fillTerrain(canvas, { material: base as never });
      if (!res.ok) return { text: `begin_map: unknown baseTerrain "${base}"`, isError: true, done: false };
    }
    state.canvas = canvas;
    state.name = String(input.name ?? state.name);
    state.description = String(input.description ?? state.description);
    return { text: `Canvas ${width}×${height} created (base: ${base}).\n\n${renderCanvasAscii(canvas)}`, isError: false, done: false };
  }

  const c = state.canvas;
  if (!c) return { text: 'Call begin_map first to create the canvas.', isError: true, done: false };

  if (name === 'finish') {
    state.name = String(input.name ?? state.name);
    state.description = String(input.description ?? state.description);
    const repairLog = autoRepairConnectivity(c);
    const v = validateCanvas(c);
    const note = v.ok ? 'Validation passed.' : `Validation warnings: ${v.issues.join('; ')}.`;
    return { text: `${repairLog} ${note}`, isError: false, done: true };
  }

  let res: OpResult;
  switch (name) {
    case 'stamp_room':      res = stampRoom(c, { x: n(input.x), y: n(input.y), w: n(input.w), h: n(input.h), floor: input.floor as never, doorways: input.doorways as never, walls: input.walls as never, zone: input.zoneName ? { name: String(input.zoneName) } : undefined }); break;
    case 'place_building':  res = placeBuilding(c, { x: n(input.x), y: n(input.y), w: n(input.w), h: n(input.h), doorSide: input.doorSide as never, floor: input.floor as never, name: input.name as never }); break;
    case 'carve_corridor':  res = carveCorridor(c, { from: input.from as never, to: input.to as never, width: input.width as never, floor: input.floor as never }); break;
    case 'lay_path':        res = layPath(c, { waypoints: input.waypoints as never }); break;
    case 'place_water':     res = placeWaterBody(c, { mode: input.mode as never, side: input.side as never, depth: input.depth as never, rect: input.rect as never }); break;
    case 'place_hazard':    res = placeHazard(c, { rect: input.rect as never, cells: input.cells as never, material: input.material as never }); break;
    case 'scatter_decor':   res = scatterDecor(c, { biome: input.biome as never, rect: input.rect as never }); break;
    case 'place_campsite':  res = placeCampsite(c, { x: n(input.x), y: n(input.y) }); break;
    case 'paint_region':    res = paintRegion(c, { rect: input.rect as never, cells: input.cells as never, material: String(input.material), layer: input.layer as never }); break;
    case 'define_zone':     res = defineZone(c, { name: String(input.name), color: input.color as never, rect: input.rect as never, cells: input.cells as never }); break;
    case 'wall_around_floor': res = wallAroundFloor(c); break;
    default: return { text: `Unknown tool "${name}".`, isError: true, done: false };
  }
  if (!res.ok) return { text: `${name}: ${res.error}`, isError: true, done: false };
  return { text: `${res.summary}\n\n${renderCanvasAscii(c)}`, isError: false, done: false };
}

const n = (v: unknown): number => Number(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.floor(v || lo)));
/** Stable seed from the map name + size so a given build is reproducible. */
function deriveSeed(name: string, w: number, h: number): number {
  let s = 0x811c9dc5 ^ (w * 73856093) ^ (h * 19349663);
  for (let i = 0; i < name.length; i++) { s ^= name.charCodeAt(i); s = Math.imul(s, 0x01000193); }
  return s >>> 0;
}

/** Join disconnected passable regions to the largest one with carved corridors,
 *  so every map ships fully reachable. Returns a one-line log. */
function autoRepairConnectivity(c: MapCanvas): string {
  const { labels, sizes } = passableRegions(c);
  if (sizes.length <= 1) return 'Map is fully connected.';
  // Representative cell per region + the largest region's id.
  const reps = new Map<number, { x: number; y: number }>();
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const l = labels[y][x];
    if (l >= 0 && !reps.has(l)) reps.set(l, { x, y });
  }
  let largest = 0;
  for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[largest]) largest = i;
  const target = reps.get(largest)!;
  const targetFloor = inferFloorMaterial(c, target.x, target.y);
  let joined = 0;
  for (const [label, rep] of reps) {
    if (label === largest) continue;
    const floor = inferFloorMaterial(c, rep.x, rep.y) ?? targetFloor ?? 'stone_floor';
    const r = carveCorridor(c, { from: rep, to: target, floor: floor as never });
    if (r.ok) joined++;
  }
  return `Auto-connected ${joined} stray region(s) to the main area.`;
}

const GID_TO_GROUND = new Map(Object.entries(GROUND_MATERIALS).map(([name, gid]) => [gid, name]));
function inferFloorMaterial(c: MapCanvas, x: number, y: number): string | undefined {
  return GID_TO_GROUND.get(c.getGround(x, y) & 0x1fffffff);
}

// ── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(defs: GameDefs): string {
  const setting = settingPromptBlock(defs.activeSetting, 'full');
  return `${setting ? setting + '\n\n' : ''}You are a tactical LEVEL DESIGNER for a 2D top-down RPG. You build a map by CALLING TOOLS — never by describing tiles. Each tool performs a guaranteed-valid operation (walls always align and enclose, corridors always connect, paths and water auto-tile), so you focus purely on composition: what goes where, how big, how many.

WORKFLOW:
1. Call begin_map FIRST (size + base ground + a place name & description).
2. Build the scene with operations. After every call you receive an ASCII render of the current map — READ IT and adjust: fix gaps, reposition overlaps, ensure spaces connect.
3. Call finish when done. The server validates connectivity and persists the map.

COORDINATES: x increases right, y increases down. (0,0) is top-left. The render shows a ruler.

MATERIALS (use these names; never raw numbers):
- ground floors: ${(MATERIAL_NAMES.ground as unknown as string[]).join(', ')}
- hazards (impassable): ${(MATERIAL_NAMES.hazard as unknown as string[]).join(', ')}

DESIGN PRINCIPLES:
- ONE clear focal feature (a courtyard, the central hall, the campfire), with the rest arranged around it. Avoid uniform fields.
- CONNECTIVITY IS REQUIRED: every passable area must be reachable from every other. Use carve_corridor / lay_path / doorways to link rooms. (The server will auto-join stragglers, but design for connection.)
- Interiors (rooms, buildings) get enclosing walls with deliberate doorways. Outdoor scenes get definition from edges — tree lines, water, ruins — not a full wall.
- Use walls, water, hazards, and decor to shape SIGHTLINES and CHOKEPOINTS — this is a combat stage.
- Vary materials between regions (a building's stone floor vs the grass outside; a cavern's gravel vs its dust).
- Tag tactically interesting spots with define_zone (e.g. "entrance", "high ground", "ambush", "vault") so the encounter author can use them.

BIOME GUIDANCE (begin_map baseTerrain options give varied palette fills: grassland, forest, dungeon, cave, urban):
- Cavern: either base "cave" (varied rock floor) then carve, OR base "void" then carve organic floor with rooms+corridors and call wall_around_floor to enclose it; add pools and chasms as hazards.
- Settlement/town: base "urban" (varied paving) or pave regions with cobbles/bricks/slabs/plaza; place_building several structures; connect with lay_path; maybe a plaza focal square.
- Wilderness: grassland/forest base; scatter_decor for trees/flowers; add a pond or coastline; a path or campsite.
- Dungeon: "void" base; stamp_room or carve rooms; connect with corridors; one room as the deep "vault".

KEEP IT EFFICIENT: a good map is usually 8-20 operations. Don't paint cell-by-cell when a room/region op will do.

TONE for name/description: gritty, grounded fantasy. The description states what is THERE (terrain, structures, atmosphere) — not what happens, no characters.`;
}

// ── Main loop ────────────────────────────────────────────────────────────────

/** Minimal slice of the Anthropic client this module needs — lets tests inject
 *  a scripted model without the real SDK / API key. */
export interface MessageCreator {
  messages: { create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

/**
 * Run the agentic build loop and return the finished ComposedMap — no disk I/O,
 * so it is unit-testable with a scripted model. `generateMapAgentic` wraps this
 * with persistence.
 */
export async function runAgenticBuild(anthropic: MessageCreator, defs: GameDefs, req: AgenticMapRequest): Promise<ComposedMap> {
  const tools = buildTools();
  const system = buildSystemPrompt(defs);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Build this map:\n\n${req.prompt}\n\nStart with begin_map.` },
  ];
  const state: Dispatch = { canvas: null, name: 'Untitled', description: '' };

  let ops = 0;
  let finished = false;
  for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1536,
      system,
      tools,
      tool_choice: ops >= MAX_OPS ? { type: 'tool', name: 'finish' } : { type: 'any' },
      messages,
    });
    messages.push({ role: 'assistant', content: resp.content });
    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const { text, isError, done } = applyTool(state, tu.name, (tu.input ?? {}) as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: text, is_error: isError });
      ops++;
      if (done) finished = true;
    }
    messages.push({ role: 'user', content: results });
  }

  if (!state.canvas) throw new Error('Map generation produced no canvas (model never called begin_map).');
  // Safety net: if the model stopped without finishing, still validate + repair.
  if (!finished) autoRepairConnectivity(state.canvas);
  return state.canvas.toComposedMap(state.name || 'Generated Map', state.description || '');
}

export async function generateMapAgentic(anthropic: Anthropic, defs: GameDefs, req: AgenticMapRequest): Promise<GeneratedMap> {
  const composed = await runAgenticBuild(anthropic, defs, req);
  const stamp = Date.now();
  const slug = slugify(composed.name).slice(0, 32) || 'map';
  const mapId = safeId(`gen_${stamp}_${slug}`);
  const mapJson = buildMapJson({
    id: mapId,
    name: composed.name,
    description: composed.description,
    width: composed.width,
    height: composed.height,
    terrainData: composed.terrainData,
    objectData: composed.objectData,
    tilesets: composed.tilesets,
    zones: composed.zones,
  });
  mkdirSync(join(DATA_DIR, 'maps'), { recursive: true });
  writeFileSync(join(DATA_DIR, 'maps', `${mapId}.json`), JSON.stringify(mapJson, null, 2));

  return {
    mapId,
    width: composed.width,
    height: composed.height,
    terrainData: composed.terrainData,
    objectData: composed.objectData,
    name: composed.name,
    description: composed.description,
  };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
