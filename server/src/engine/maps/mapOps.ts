/**
 * Map operations — the deterministic toolbox that builds a `MapCanvas`. Each op
 * takes the canvas plus explicit, designer-named parameters (positions, sizes,
 * material names) and either applies a guaranteed-valid mutation or returns a
 * precise error. The correctness the AI map generator lacked when it emitted
 * raw tile arrays lives HERE: walls always align and enclose, corridors always
 * connect, paths auto-tile, water auto-shores, decoration clusters.
 *
 * Two callers drive these ops:
 *   • the agentic AI generator, exposing them as tools (the model picks what /
 *     where / how big; the op guarantees the geometry), and
 *   • the deterministic `composeMap`, which can be re-expressed in terms of them.
 *
 * The logic is ported from the original per-terrain composers (`outdoor.ts`,
 * `dungeon.ts`, `tavern.ts`) so op-built maps render identically to composed
 * ones.
 */
import { BIOME_PALETTES, pickGroundGid, rollObjectGid, type BiomeId } from '../../../../shared/biomePalettes.js';
import { WALL_GIDS, PATH_GIDS, WATER_GIDS, WATER_FIRSTGID } from '../mapTiles.js';
import { MapCanvas } from './MapCanvas.js';
import {
  GROUND_PAINTABLE, OBJECT_PAINTABLE, WALL_RING,
  groundGid, objectGid, groundBlocksMovement, objectBlocksMovement,
  type GroundMaterial, type HazardMaterial,
} from './materials.js';

export interface Point { x: number; y: number; }
export interface Rect { x: number; y: number; w: number; h: number; }

export type OpResult = { ok: true; summary: string } | { ok: false; error: string };
const ok = (summary: string): OpResult => ({ ok: true, summary });
const fail = (error: string): OpResult => ({ ok: false, error });

// ── Geometry helpers ─────────────────────────────────────────────────────────

function clampRectToCanvas(c: MapCanvas, r: Rect): Rect {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(c.width, Math.floor(r.x + r.w));
  const y2 = Math.min(c.height, Math.floor(r.y + r.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

function* rectCells(r: Rect): Generator<Point> {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) yield { x, y };
}

/** Resolve a region given as either a rect or an explicit cell list. */
function resolveCells(c: MapCanvas, region: { rect?: Rect; cells?: Point[] }): Point[] {
  if (region.cells) return region.cells.filter((p) => c.inBounds(p.x, p.y));
  if (region.rect) return [...rectCells(clampRectToCanvas(c, region.rect))];
  return [];
}

// ── fillTerrain ──────────────────────────────────────────────────────────────

export interface FillTerrainParams { biome?: BiomeId; material?: GroundMaterial; }

/** Lay the base ground across the whole canvas — either a biome palette (varied
 *  ground via weighted pick) or a single flat material. */
export function fillTerrain(c: MapCanvas, p: FillTerrainParams): OpResult {
  if (p.biome) {
    const palette = BIOME_PALETTES[p.biome];
    if (!palette) return fail(`unknown biome "${p.biome}"`);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) c.setGround(x, y, pickGroundGid(palette, c.rng));
    return ok(`filled ${c.width}×${c.height} with ${p.biome} ground`);
  }
  if (p.material) {
    const gid = groundGid(p.material);
    if (gid === undefined) return fail(`unknown ground material "${p.material}"`);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) c.setGround(x, y, gid);
    return ok(`filled ${c.width}×${c.height} with ${p.material}`);
  }
  return fail('fillTerrain needs a biome or a material');
}

// ── paintRegion ──────────────────────────────────────────────────────────────

export interface PaintRegionParams {
  rect?: Rect;
  cells?: Point[];
  material: string;
  layer: 'ground' | 'object';
}

/** Low-level escape hatch: paint a material onto a rect or cell list, on the
 *  chosen layer. Layer-validated — a ground material can't go on the object
 *  layer and vice versa. */
export function paintRegion(c: MapCanvas, p: PaintRegionParams): OpResult {
  const cells = resolveCells(c, p);
  if (cells.length === 0) return fail('paintRegion: empty/out-of-bounds region');
  if (p.layer === 'ground') {
    const gid = (GROUND_PAINTABLE as Record<string, number>)[p.material];
    if (gid === undefined) return fail(`"${p.material}" is not a ground material`);
    for (const { x, y } of cells) c.setGround(x, y, gid);
  } else {
    const gid = (OBJECT_PAINTABLE as Record<string, number>)[p.material];
    if (gid === undefined) return fail(`"${p.material}" is not an object material`);
    for (const { x, y } of cells) c.setObject(x, y, gid);
  }
  return ok(`painted ${cells.length} ${p.layer} cell(s) with ${p.material}`);
}

// ── placeHazard ──────────────────────────────────────────────────────────────

export interface PlaceHazardParams { rect?: Rect; cells?: Point[]; material: HazardMaterial; }

/** Paint impassable hazard ground (pool / chasm) — a tactical obstacle. */
export function placeHazard(c: MapCanvas, p: PlaceHazardParams): OpResult {
  const gid = groundGid(p.material);
  if (gid === undefined) return fail(`unknown hazard "${p.material}"`);
  const cells = resolveCells(c, p);
  if (cells.length === 0) return fail('placeHazard: empty/out-of-bounds region');
  for (const { x, y } of cells) { c.setGround(x, y, gid); c.setObject(x, y, 0); }
  return ok(`placed ${cells.length} ${p.material} hazard cell(s)`);
}

// ── stampRoom ────────────────────────────────────────────────────────────────

export interface StampRoomParams {
  x: number; y: number; w: number; h: number;
  floor: GroundMaterial;
  /** Perimeter cells to leave open as doorways (must lie on the wall ring). */
  doorways?: Point[];
  /** Draw the wall ring (default true). False = an open paved area, no walls. */
  walls?: boolean;
  /** Emit an author-time zone over the interior. */
  zone?: { name: string; color?: string };
}

/** Stamp a rectangular room: floor fill + aligned wall ring with correct corner
 *  rotations + carved doorways. The single primitive behind buildings, taverns,
 *  and dungeon vaults (ported from `placeBuildings` / tavern wall logic). */
export function stampRoom(c: MapCanvas, p: StampRoomParams): OpResult {
  const x = Math.floor(p.x), y = Math.floor(p.y), w = Math.floor(p.w), h = Math.floor(p.h);
  if (w < 3 || h < 3) return fail(`room too small (${w}×${h}); minimum 3×3`);
  if (x < 0 || y < 0 || x + w > c.width || y + h > c.height) return fail(`room ${w}×${h} at (${x},${y}) is out of bounds`);
  const floorGid = groundGid(p.floor);
  if (floorGid === undefined) return fail(`unknown floor material "${p.floor}"`);
  const drawWalls = p.walls !== false;
  const doorSet = new Set((p.doorways ?? []).map((d) => `${Math.floor(d.x)},${Math.floor(d.y)}`));

  const interior: string[] = [];
  for (let r = y; r < y + h; r++) {
    for (let col = x; col < x + w; col++) {
      c.setGround(col, r, floorGid);
      c.reserve(col, r);
      interior.push(`${col},${r}`);
      if (!drawWalls) continue;
      const isN = r === y, isS = r === y + h - 1, isW = col === x, isE = col === x + w - 1;
      if (!(isN || isS || isW || isE)) continue;
      if (doorSet.has(`${col},${r}`)) { c.setObject(col, r, 0); continue; }
      if (isN && isW)      c.setObject(col, r, WALL_RING.CORNER_TL);
      else if (isN && isE) c.setObject(col, r, WALL_RING.CORNER_TR);
      else if (isS && isW) c.setObject(col, r, WALL_RING.CORNER_BL);
      else if (isS && isE) c.setObject(col, r, WALL_RING.CORNER_BR);
      else if (isN)        c.setObject(col, r, WALL_RING.NORTH);
      else if (isS)        c.setObject(col, r, WALL_RING.SOUTH);
      else if (isW)        c.setObject(col, r, WALL_RING.WEST);
      else                 c.setObject(col, r, WALL_RING.EAST);
    }
  }
  if (p.zone) c.addZone('room', p.zone.name, p.zone.color ?? '#8866cc', interior);
  return ok(`stamped ${w}×${h} ${p.floor} room at (${x},${y})${drawWalls ? ` with ${doorSet.size} doorway(s)` : ' (open)'}`);
}

// ── placeBuilding ────────────────────────────────────────────────────────────

export interface PlaceBuildingParams {
  x: number; y: number; w: number; h: number;
  floor?: GroundMaterial;
  doorSide?: 'N' | 'S' | 'E' | 'W';
  name?: string;
}

/** A building = a stone-floored walled room with a single auto-placed doorway
 *  on the chosen (or a deterministic) side. Convenience wrapper over stampRoom. */
export function placeBuilding(c: MapCanvas, p: PlaceBuildingParams): OpResult {
  const x = Math.floor(p.x), y = Math.floor(p.y), w = Math.floor(p.w), h = Math.floor(p.h);
  if (w < 3 || h < 3) return fail(`building too small (${w}×${h}); minimum 3×3`);
  const side = p.doorSide ?? (['N', 'S', 'E', 'W'] as const)[Math.floor(c.rng() * 4)];
  let door: Point;
  if (side === 'N')      door = { x: x + 1 + Math.floor(c.rng() * (w - 2)), y };
  else if (side === 'S') door = { x: x + 1 + Math.floor(c.rng() * (w - 2)), y: y + h - 1 };
  else if (side === 'W') door = { x, y: y + 1 + Math.floor(c.rng() * (h - 2)) };
  else                   door = { x: x + w - 1, y: y + 1 + Math.floor(c.rng() * (h - 2)) };
  const res = stampRoom(c, { x, y, w, h, floor: p.floor ?? 'stone_floor', doorways: [door], zone: { name: p.name ?? 'building', color: '#8866cc' } });
  if (!res.ok) return res;
  (c.anchors.buildings ??= []).push({ x, y, w, h });
  return ok(`placed building ${w}×${h} at (${x},${y}), door on ${side}`);
}

// ── carveCorridor ────────────────────────────────────────────────────────────

export interface CarveCorridorParams { from: Point; to: Point; width?: number; floor: GroundMaterial; }

/** Carve an L-shaped corridor of floor between two points, clearing any wall
 *  objects in its path so it always connects. Width 1 or 2. */
export function carveCorridor(c: MapCanvas, p: CarveCorridorParams): OpResult {
  const floorGid = groundGid(p.floor);
  if (floorGid === undefined) return fail(`unknown floor material "${p.floor}"`);
  const x1 = Math.floor(p.from.x), y1 = Math.floor(p.from.y), x2 = Math.floor(p.to.x), y2 = Math.floor(p.to.y);
  if (!c.inBounds(x1, y1) || !c.inBounds(x2, y2)) return fail('corridor endpoint out of bounds');
  const width = p.width === 2 ? 2 : 1;
  let cut = 0;
  const carve = (x: number, y: number): void => {
    for (let dy = 0; dy < width; dy++) for (let dx = 0; dx < width; dx++) {
      const cx = x + dx, cy = y + dy;
      if (!c.inBounds(cx, cy)) continue;
      c.setGround(cx, cy, floorGid);
      c.setObject(cx, cy, 0); // punch through walls
      c.reserve(cx, cy);
      cut++;
    }
  };
  // Horizontal-first or vertical-first by start-cell parity (matches dungeon).
  if ((x1 + y1) % 2 === 0) {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) carve(x, y1);
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) carve(x2, y);
  } else {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) carve(x1, y);
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) carve(x, y2);
  }
  return ok(`carved corridor (${x1},${y1})→(${x2},${y2}), ${cut} cells`);
}

// ── layPath ──────────────────────────────────────────────────────────────────

export interface LayPathParams { waypoints: Point[]; zone?: boolean; }

/** Lay an auto-tiled dirt path on the object layer through a list of waypoints,
 *  connecting consecutive ones with L segments. Each cell's tile + rotation is
 *  chosen from its 4-neighbour mask (ported from `placePath`). Skips water. */
export function layPath(c: MapCanvas, p: LayPathParams): OpResult {
  if (!p.waypoints || p.waypoints.length < 2) return fail('layPath needs at least 2 waypoints');
  const pathCells = new Set<string>();
  const isWater = (x: number, y: number): boolean => {
    const g = c.getGround(x, y) & 0x1fffffff;
    return g >= WATER_FIRSTGID && g < WATER_FIRSTGID + 16;
  };
  const paint = (x: number, y: number): void => {
    if (!c.inBounds(x, y) || isWater(x, y)) return;
    pathCells.add(`${x},${y}`);
    c.reserve(x, y);
  };
  for (let i = 1; i < p.waypoints.length; i++) {
    const a = p.waypoints[i - 1], b = p.waypoints[i];
    const ax = Math.floor(a.x), ay = Math.floor(a.y), bx = Math.floor(b.x), by = Math.floor(b.y);
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) paint(x, ay);
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) paint(bx, y);
  }
  if (pathCells.size === 0) return fail('layPath: every waypoint segment fell on water/out of bounds');
  const inPath = (x: number, y: number): boolean => pathCells.has(`${x},${y}`);
  for (const cell of pathCells) {
    const [sx, sy] = cell.split(',');
    const x = parseInt(sx, 10), y = parseInt(sy, 10);
    const n = inPath(x, y - 1), s = inPath(x, y + 1), e = inPath(x + 1, y), w = inPath(x - 1, y);
    const mask = (n ? 8 : 0) | (s ? 4 : 0) | (e ? 2 : 0) | (w ? 1 : 0);
    let gid: number;
    switch (mask) {
      case 0b1100: gid = PATH_GIDS.V; break;
      case 0b0011: gid = PATH_GIDS.H; break;
      case 0b1111: gid = PATH_GIDS.INTERSECTION; break;
      case 0b0110: gid = PATH_GIDS.CORNER_SE; break;
      case 0b0101: gid = PATH_GIDS.CORNER_SW; break;
      case 0b1001: gid = PATH_GIDS.CORNER_NW; break;
      case 0b1010: gid = PATH_GIDS.CORNER_NE; break;
      case 0b1000: case 0b0100: gid = PATH_GIDS.V; break;
      case 0b0010: case 0b0001: gid = PATH_GIDS.H; break;
      case 0b1110: case 0b1101: case 0b1011: case 0b0111: gid = PATH_GIDS.INTERSECTION; break;
      default: gid = PATH_GIDS.H;
    }
    c.setObject(x, y, gid);
  }
  if (p.zone !== false) c.addZone('path', 'path', '#cc9966', pathCells);
  return ok(`laid path of ${pathCells.size} cells through ${p.waypoints.length} waypoints`);
}

// ── placeWaterBody ───────────────────────────────────────────────────────────

export interface PlaceWaterBodyParams {
  mode: 'edge' | 'pond';
  side?: 'N' | 'S' | 'E' | 'W';
  depth?: number;
  rect?: Rect;
}

/** Place water as either an edge flood (a coast — ported from `placeCoastline`)
 *  or a rectangular pond with auto-tiled shores using the water edge tiles. */
export function placeWaterBody(c: MapCanvas, p: PlaceWaterBodyParams): OpResult {
  if (p.mode === 'edge') {
    const side = p.side ?? (['N', 'S', 'E', 'W'] as const)[Math.floor(c.rng() * 4)];
    const depth = Math.max(2, Math.floor(p.depth ?? (side === 'N' || side === 'S' ? c.height * 0.4 : c.width * 0.4)));
    const fillCol = (r: number, shoreTile: number, isShore: boolean): void => {
      for (let col = 0; col < c.width; col++) { c.setObject(col, r, 0); c.setGround(col, r, isShore ? shoreTile : WATER_GIDS.WATER); }
    };
    const fillRow = (col: number, shoreTile: number, isShore: boolean): void => {
      for (let r = 0; r < c.height; r++) { c.setObject(col, r, 0); c.setGround(col, r, isShore ? shoreTile : WATER_GIDS.WATER); }
    };
    if (side === 'N')      for (let r = 0; r < depth; r++) fillCol(r, WATER_GIDS.EDGE_S, r === depth - 1);
    else if (side === 'S') for (let r = c.height - depth; r < c.height; r++) fillCol(r, WATER_GIDS.EDGE_N, r === c.height - depth);
    else if (side === 'W') for (let col = 0; col < depth; col++) fillRow(col, WATER_GIDS.EDGE_E, col === depth - 1);
    else                   for (let col = c.width - depth; col < c.width; col++) fillRow(col, WATER_GIDS.EDGE_W, col === c.width - depth);
    recordInlandBand(c, side);
    return ok(`flooded ${side} edge with water (depth ${depth})`);
  }
  // pond
  if (!p.rect) return fail('pond mode needs a rect');
  const r = clampRectToCanvas(c, p.rect);
  if (r.w < 3 || r.h < 3) return fail(`pond too small (${r.w}×${r.h}); minimum 3×3`);
  for (const { x, y } of rectCells(r)) { c.setObject(x, y, 0); c.setGround(x, y, WATER_GIDS.WATER); }
  // Shore ring: cardinal edges get the matching grass-side edge tile; this reads
  // as a rounded pond without needing a full Wang-tile solve.
  for (let x = r.x; x < r.x + r.w; x++) {
    c.setGround(x, r.y, WATER_GIDS.EDGE_N);
    c.setGround(x, r.y + r.h - 1, WATER_GIDS.EDGE_S);
  }
  for (let y = r.y; y < r.y + r.h; y++) {
    c.setGround(r.x, y, WATER_GIDS.EDGE_W);
    c.setGround(r.x + r.w - 1, y, WATER_GIDS.EDGE_E);
  }
  c.setGround(r.x, r.y, WATER_GIDS.OUTER_NW);
  c.setGround(r.x + r.w - 1, r.y, WATER_GIDS.OUTER_NE);
  c.setGround(r.x, r.y + r.h - 1, WATER_GIDS.OUTER_SW);
  c.setGround(r.x + r.w - 1, r.y + r.h - 1, WATER_GIDS.OUTER_SE);
  return ok(`placed ${r.w}×${r.h} pond at (${r.x},${r.y})`);
}

function recordInlandBand(c: MapCanvas, side: 'N' | 'S' | 'E' | 'W'): void {
  const band: Point[] = [];
  if (side === 'N')      for (let x = 0; x < c.width; x++) for (let i = 0; i < 3; i++) band.push({ x, y: c.height - 1 - i });
  else if (side === 'S') for (let x = 0; x < c.width; x++) for (let i = 0; i < 3; i++) band.push({ x, y: i });
  else if (side === 'W') for (let y = 0; y < c.height; y++) for (let i = 0; i < 3; i++) band.push({ x: c.width - 1 - i, y });
  else                   for (let y = 0; y < c.height; y++) for (let i = 0; i < 3; i++) band.push({ x: i, y });
  c.anchors.inlandBand = band;
}

// ── scatterDecor ─────────────────────────────────────────────────────────────

export interface ScatterDecorParams { biome: BiomeId; rect?: Rect; }

/** Sprinkle the biome's object pool (trees/flowers, clustered per palette) over
 *  untouched natural-ground cells in a region (default whole map). Ported from
 *  `applyObjectPool`; never overwrites existing objects or reserved cells. */
export function scatterDecor(c: MapCanvas, p: ScatterDecorParams): OpResult {
  const palette = BIOME_PALETTES[p.biome];
  if (!palette) return fail(`unknown biome "${p.biome}"`);
  if (palette.objectPool.length === 0) return ok(`${p.biome} has no decoration pool; nothing to scatter`);
  const region = p.rect ? clampRectToCanvas(c, p.rect) : { x: 0, y: 0, w: c.width, h: c.height };
  const naturalGround = new Set(palette.groundPool.map((e) => e.gid));
  const isWall = (x: number, y: number): boolean => {
    if (!c.inBounds(x, y)) return false;
    return !naturalGround.has(c.getGround(x, y) & 0x1fffffff);
  };
  const flat = new Array<number>(c.width * c.height).fill(0);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) flat[y * c.width + x] = c.getObject(x, y);
  let placed = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      if (c.getObject(x, y) !== 0 || c.isReserved(x, y)) continue;
      if (!naturalGround.has(c.getGround(x, y) & 0x1fffffff)) continue;
      const gid = rollObjectGid(palette, c.rng, x, y, c.width, c.height, flat, isWall);
      if (gid !== 0) { c.setObject(x, y, gid); flat[y * c.width + x] = gid; placed++; }
    }
  }
  return ok(`scattered ${placed} ${p.biome} decoration(s)`);
}

// ── placeCampsite ────────────────────────────────────────────────────────────

export interface PlaceCampsiteParams { x: number; y: number; }

/** Drop a campfire with flanking firewood + crate (ported from `placeCampsites`). */
export function placeCampsite(c: MapCanvas, p: PlaceCampsiteParams): OpResult {
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  if (!c.inBounds(cx, cy)) return fail('campsite out of bounds');
  c.setObject(cx, cy, OBJECT_PAINTABLE.campfire);
  (c.anchors.campfires ??= []).push({ x: cx, y: cy });
  const fwGid = OBJECT_PAINTABLE.firewood, crGid = OBJECT_PAINTABLE.crate;
  if (c.inBounds(cx - 1, cy) && c.getObject(cx - 1, cy) === 0) c.setObject(cx - 1, cy, fwGid);
  if (c.inBounds(cx + 1, cy) && c.getObject(cx + 1, cy) === 0) c.setObject(cx + 1, cy, crGid);
  return ok(`placed campsite at (${cx},${cy})`);
}

// ── defineZone ───────────────────────────────────────────────────────────────

export interface DefineZoneParams { name: string; color?: string; rect?: Rect; cells?: Point[]; }

/** Tag a region with an author-time named zone (downstream encounter authoring
 *  + the AIGM read these). Purely semantic; paints nothing. */
export function defineZone(c: MapCanvas, p: DefineZoneParams): OpResult {
  if (!p.name) return fail('defineZone needs a name');
  const cells = resolveCells(c, p);
  if (cells.length === 0) return fail('defineZone: empty/out-of-bounds region');
  c.addZone('zone', p.name, p.color ?? '#66aacc', cells.map((pt) => `${pt.x},${pt.y}`));
  return ok(`defined zone "${p.name}" over ${cells.length} cell(s)`);
}

// ── wallAroundFloor (organic walls; used by caves) ──────────────────────────

/** Wrap every void cell adjacent to floor with the correct wall tile from its
 *  8-neighbour floor mask (ported from the dungeon renderer). Use after carving
 *  an organic floor shape so caverns get clean, correctly-rotated walls. A cell
 *  counts as floor when its ground is non-zero and not water/hazard. */
export function wallAroundFloor(c: MapCanvas): OpResult {
  const isFloor = (x: number, y: number): boolean => {
    if (!c.inBounds(x, y)) return false;
    const g = c.getGround(x, y);
    return g !== 0 && !groundBlocksMovement(g) && !objectBlocksMovement(c.getObject(x, y));
  };
  let walls = 0;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (c.getGround(x, y) !== 0 || c.getObject(x, y) !== 0) continue; // only fill void
      const fN = isFloor(x, y - 1), fS = isFloor(x, y + 1), fE = isFloor(x + 1, y), fW = isFloor(x - 1, y);
      const fNW = isFloor(x - 1, y - 1), fNE = isFloor(x + 1, y - 1), fSW = isFloor(x - 1, y + 1), fSE = isFloor(x + 1, y + 1);
      if (!(fN || fS || fE || fW || fNW || fNE || fSW || fSE)) continue;
      if (fS && fE)      c.setObject(x, y, WALL_GIDS.PARTIAL_CORNER_UL);
      else if (fS && fW) c.setObject(x, y, WALL_GIDS.PARTIAL_CORNER_UR);
      else if (fN && fE) c.setObject(x, y, WALL_GIDS.PARTIAL_CORNER_LL);
      else if (fN && fW) c.setObject(x, y, WALL_GIDS.PARTIAL_CORNER_LR);
      else if (fS) c.setObject(x, y, WALL_GIDS.NORTH);
      else if (fN) c.setObject(x, y, WALL_GIDS.SOUTH);
      else if (fE) c.setObject(x, y, WALL_GIDS.WEST);
      else if (fW) c.setObject(x, y, WALL_GIDS.EAST);
      else if (fSE) c.setObject(x, y, WALL_GIDS.CORNER_TL);
      else if (fSW) c.setObject(x, y, WALL_GIDS.CORNER_TR);
      else if (fNE) c.setObject(x, y, WALL_GIDS.CORNER_BL);
      else if (fNW) c.setObject(x, y, WALL_GIDS.CORNER_BR);
      // The wall cell needs a floor under its transparent twin.
      c.setGround(x, y, GROUND_PAINTABLE.cave_rock);
      walls++;
    }
  }
  return ok(`walled ${walls} cell(s) around floor`);
}

// ── validateCanvas + connectivity ───────────────────────────────────────────

export interface ValidateResult {
  ok: boolean;
  issues: string[];
  passableCells: number;
  largestRegion: number;
  regionCount: number;
}

/** Effective movement-blocking test for a cell (object overrides ground). */
function cellBlocks(c: MapCanvas, x: number, y: number): boolean {
  const obj = c.getObject(x, y);
  if (obj !== 0) return objectBlocksMovement(obj);
  return groundBlocksMovement(c.getGround(x, y));
}

/** Flood-fill the passable cells into connected regions. Returns the region
 *  label grid plus sizes. Exposed so auto-repair can join components. */
export function passableRegions(c: MapCanvas): { labels: number[][]; sizes: number[] } {
  const labels: number[][] = Array.from({ length: c.height }, () => new Array<number>(c.width).fill(-1));
  const sizes: number[] = [];
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (labels[y][x] !== -1 || cellBlocks(c, x, y)) continue;
      const label = sizes.length;
      let size = 0;
      const stack: Point[] = [{ x, y }];
      labels[y][x] = label;
      while (stack.length) {
        const cur = stack.pop()!;
        size++;
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (!c.inBounds(nx, ny) || labels[ny][nx] !== -1 || cellBlocks(c, nx, ny)) continue;
          labels[ny][nx] = label;
          stack.push({ x: nx, y: ny });
        }
      }
      sizes.push(size);
    }
  }
  return { labels, sizes };
}

/** Check playability invariants: a minimum connected passable area exists, and
 *  (optionally) the whole playable space is one region. Pure — reports only. */
export function validateCanvas(c: MapCanvas, opts: { minPassable?: number } = {}): ValidateResult {
  const { sizes } = passableRegions(c);
  const passableCells = sizes.reduce((a, b) => a + b, 0);
  const largestRegion = sizes.length ? Math.max(...sizes) : 0;
  const minPassable = opts.minPassable ?? 24;
  const issues: string[] = [];
  if (largestRegion < minPassable) issues.push(`largest connected passable region is ${largestRegion} cells (need ≥ ${minPassable})`);
  if (sizes.length > 1) issues.push(`${sizes.length} disconnected passable regions (should be 1 for full reachability)`);
  return { ok: issues.length === 0, issues, passableCells, largestRegion, regionCount: sizes.length };
}
