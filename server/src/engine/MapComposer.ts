/**
 * MapComposer — deterministic map generator (the Adjudicator-layer alternative
 * to the AI map generator in `encounterGenerator.ts`).
 *
 * Composes a Tiled-shaped map from a small vocabulary of high-level toggles
 * (terrain + features). All randomness is seeded so the same input produces
 * the same map, which makes it cheap to iterate via the preview overlay.
 *
 * The core primitive is `stampRoom` — it lays down a rectangular building
 * with correctly-rotated walls, corner tiles, and optional doorways. Higher-
 * level features (ruins, buildings, campsites, coastline) are layered
 * on top of a base terrain (grassland or forest); dungeons take a separate
 * path that carves rooms + corridors out of a solid wall fill.
 */

// ── Tileset palettes ────────────────────────────────────────────────────────
//
// Scribble lives at firstgid=1 (155 tiles, ids 0-154). Water lives at
// firstgid=WATER_FIRSTGID below that; the saved map JSON declares both
// tilesets so the renderer + passability resolver pick the right one.
//
// Multilayer composition: ground variation comes from `BIOME_PALETTES`
// (weighted-random pool per biome) and object decoration uses the
// transparent-twin GIDs of the scribble tileset so the ground texture is
// visible underneath. Feature-placer object GIDs below are likewise
// transparent twins (e.g. `TREE` → 110 not 103, `FLOWERS` → 96 not 89).

import { BIOME_PALETTES, pickGroundGid, rollObjectGid, type BiomePalette } from '../../../shared/biomePalettes.js';

export const WATER_FIRSTGID = 200;
const WL = WATER_FIRSTGID; // local shorthand for the water tileset offset

const G = {
  GRASS: 8,
  STONE_FLOOR: 15,
  STONE_FLOOR_CRACKED: 71,
  WALL_NORTH: 4,
  WALL_SOUTH: 4 + 0xC0000000,           // 180°
  WALL_EAST:  4 + 0xA0000000,           // 90° CW
  WALL_WEST:  4 + 0x60000000,           // 270° CW
  // CORNER_* — `stone_wall_corner_tl` (an L-shaped corner piece). Used at the
  // four convex corners of a rectangular room (wall art faces outward, away
  // from the room interior). stampRoom / outdoor buildings use this set.
  CORNER_TL:  3,
  CORNER_TR:  3 + 0xA0000000,
  CORNER_BR:  3 + 0xC0000000,
  CORNER_BL:  3 + 0x60000000,
  // PARTIAL_CORNER_* — `stone_wall_corner_ul` (tile id 58, gid 59): a partial
  // wall covering one quadrant of the tile, leaving the opposite quadrant
  // open for the floor. Used at *concave* corners (e.g. where a corridor
  // joins a room) where the room interior wraps around two sides of the
  // wall tile and the wall must occupy only the outer corner of the tile.
  PARTIAL_CORNER_UL: 59,                            // wall in UL → room at LR (SE)
  PARTIAL_CORNER_UR: 59 + 0xA0000000,               // wall in UR → room at LL (SW)
  PARTIAL_CORNER_LR: 59 + 0xC0000000,               // wall in LR → room at UL (NW)
  PARTIAL_CORNER_LL: 59 + 0x60000000,               // wall in LL → room at UR (NE)
  // Object overlays. All use transparent-twin GIDs (cols 8–13 of the scribble
  // sheet) so the underlying ground tile shows through and the multilayer
  // ground palette stays visible.
  TREE: 110,            // tree_transparent
  CAMPFIRE: 82,         // campfire_transparent
  FLOWERS: 96,          // flowers_transparent
  CRATE_CLOSED: 22,     // crate_closed has no transparent twin — keep as-is
  BARRELS_TWO: 41,      // barrels_two_transparent
  FIREWOOD: 42,         // firewood_transparent
  // Path tiles — GID 2 is `path_corner_se` (connects S + E in base
  // orientation); the four rotations cover all corner orientations. GID 16
  // (`path_straight_v`) handles straight runs; its 90° rotation handles
  // horizontal straight runs. Corners are placed at every bend; straights
  // fill the runs in between so the path reads as a continuous trail.
  PATH_V: 16,                           //   0°  → N + S (vertical straight)
  PATH_H: 16 + 0xA0000000,              //  90° CW → W + E (horizontal straight)
  PATH_CORNER_SE: 2,                    //   0°  → S + E
  PATH_CORNER_SW: 2 + 0xA0000000,       //  90° CW → W + S
  PATH_CORNER_NW: 2 + 0xC0000000,       // 180°    → N + W
  PATH_CORNER_NE: 2 + 0x60000000,       // 270° CW → E + N
  // Water tileset (firstgid=WATER_FIRSTGID). Local tile ids: 0 water, 1 grass,
  // 4-7 edges N/E/S/W, 8-11 outer corners NW/NE/SE/SW, 12-15 inner corners.
  WATER:           WL + 0,
  WATER_EDGE_N:    WL + 4,
  WATER_EDGE_E:    WL + 5,
  WATER_EDGE_S:    WL + 6,
  WATER_EDGE_W:    WL + 7,
  WATER_OUTER_NW:  WL + 8,
  WATER_OUTER_NE:  WL + 9,
  WATER_OUTER_SE:  WL + 10,
  WATER_OUTER_SW:  WL + 11,
  WATER_INNER_NW:  WL + 12,
  WATER_INNER_NE:  WL + 13,
  WATER_INNER_SE:  WL + 14,
  WATER_INNER_SW:  WL + 15,
};

export type Terrain = 'grassland' | 'forest' | 'dungeon';
export type Feature =
  | 'ruins' | 'buildings' | 'campsites' | 'path'
  | 'coastline'
  | '3-room' | '5-room';

export interface ComposeOptions {
  width: number;
  height: number;
  terrain: Terrain;
  features: Feature[];
  /** Optional seed for the RNG. Same seed + same opts → same map. Defaults to Date.now(). */
  seed?: number;
}

export interface ComposedTilesetRef {
  firstgid: number;
  source: string;
}

/**
 * Named regions of interest a feature placer found / stamped. The randomizer
 * uses these to spawn the player and enemies at story-suitable locations
 * (entrance vs. vault, on a path vs. at a campfire) instead of guessing
 * geometrically. Every field is optional — only features the composer actually
 * placed end up populated.
 */
export interface MapAnchors {
  /** Every carved dungeon room as `{ rect, center }`. Sorted by `cy + cx` so [0] is closest to NW, last is deepest. */
  rooms?: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }>;
  /** Center cell of the southernmost dungeon room (where the entry corridor meets the wall). */
  entrance?: { x: number; y: number };
  /** Center cell of the dungeon room farthest from the entrance. */
  vault?: { x: number; y: number };
  /** Campfire centers placed by `placeCampsites`. */
  campfires?: Array<{ x: number; y: number }>;
  /** Building footprints (interior, ie. one cell in from the walls). */
  buildings?: Array<{ x: number; y: number; w: number; h: number }>;
  /** Ruin footprints (interior, ie. one cell in from the walls). */
  ruins?: Array<{ x: number; y: number; w: number; h: number }>;
  /** The two map-edge cells where the path emerges. */
  pathEndpoints?: Array<{ x: number; y: number }>;
  /** Cells along the dry (grass) side, away from water. Populated when `coastline` is on. */
  inlandBand?: Array<{ x: number; y: number }>;
}

export interface ComposedMap {
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
  /** Tilesets the rendered map data references, with their firstgids. */
  tilesets: ComposedTilesetRef[];
  /** Story-suitable spawn anchors derived during feature placement. */
  anchors: MapAnchors;
}

// ── stampRoom — the core support primitive ──────────────────────────────────

export interface Doorway {
  /** Which wall the doorway sits in. */
  side: 'N' | 'S' | 'E' | 'W';
  /** Offset along the wall, counted from the wall's western or northern end. Must be ≥ 1 and ≤ (wall length - 2) so the doorway doesn't fall on a corner. */
  offset: number;
  /** How wide the doorway is, in tiles. Default 1. */
  length?: number;
}

export interface RoomOptions {
  /** Top-left tile of the room (column). The room footprint is [x, x+w) × [y, y+h). */
  x: number;
  y: number;
  /** Total room width including the wall columns on both sides. Must be ≥ 3. */
  w: number;
  /** Total room height including the wall rows on both sides. Must be ≥ 3. */
  h: number;
  /** Base floor GID. */
  floorBase: number;
  /** Optional second floor GID for visual variation; mixed in via a deterministic checker pattern. */
  floorAccent?: number;
  /** Doorways carved out of the perimeter walls. Each doorway is replaced with floorBase tiles. */
  doorways?: Doorway[];
  /** When set, knock out this many random non-corner wall cells per side (in addition to the named doorways) to produce a "ruined" silhouette. Defaults to 0. */
  ruinedBreaks?: number;
  /** RNG used by `ruinedBreaks`. Required if `ruinedBreaks > 0`. */
  rng?: () => number;
}

/**
 * Stamp a rectangular room onto the given grids. Writes the wall/corner tiles
 * onto `terrain` (with proper rotations) and writes the floor onto the
 * interior. Doorways are carved out as floor tiles in the wall ring.
 *
 * The function ALWAYS overwrites whatever was at those cells. Stamp order
 * matters when rooms overlap.
 */
export function stampRoom(terrain: number[][], opts: RoomOptions): void {
  const { x, y, w, h, floorBase, floorAccent, doorways = [], ruinedBreaks = 0, rng } = opts;
  if (w < 3 || h < 3) throw new Error(`stampRoom: room must be at least 3×3 (got ${w}×${h})`);
  if (y < 0 || x < 0 || y + h > terrain.length || x + w > terrain[0].length) {
    throw new Error(`stampRoom: room extends past map boundary`);
  }

  // Resolve the set of cells that should be carved as doorways (floor instead of wall).
  const open = new Set<string>();
  for (const dw of doorways) {
    const len = dw.length ?? 1;
    if (dw.side === 'N') {
      for (let i = 0; i < len; i++) open.add(`${y},${x + dw.offset + i}`);
    } else if (dw.side === 'S') {
      for (let i = 0; i < len; i++) open.add(`${y + h - 1},${x + dw.offset + i}`);
    } else if (dw.side === 'W') {
      for (let i = 0; i < len; i++) open.add(`${y + dw.offset + i},${x}`);
    } else {
      for (let i = 0; i < len; i++) open.add(`${y + dw.offset + i},${x + w - 1}`);
    }
  }

  // Add ruined-break openings (random non-corner non-already-doorway wall cells).
  if (ruinedBreaks > 0) {
    if (!rng) throw new Error('stampRoom: ruinedBreaks > 0 requires rng');
    const candidates: string[] = [];
    for (let c = x + 1; c < x + w - 1; c++) {
      const nKey = `${y},${c}`;
      const sKey = `${y + h - 1},${c}`;
      if (!open.has(nKey)) candidates.push(nKey);
      if (!open.has(sKey)) candidates.push(sKey);
    }
    for (let r = y + 1; r < y + h - 1; r++) {
      const wKey = `${r},${x}`;
      const eKey = `${r},${x + w - 1}`;
      if (!open.has(wKey)) candidates.push(wKey);
      if (!open.has(eKey)) candidates.push(eKey);
    }
    // Fisher-Yates partial shuffle to pick `ruinedBreaks` distinct candidates.
    for (let i = 0; i < Math.min(ruinedBreaks, candidates.length); i++) {
      const j = i + Math.floor(rng() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      open.add(candidates[i]);
    }
  }

  // Paint the room: corners, edges, interior, then carve doorways/breaks.
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      const isN = r === y;
      const isS = r === y + h - 1;
      const isW = c === x;
      const isE = c === x + w - 1;

      if (isN || isS || isW || isE) {
        const key = `${r},${c}`;
        if (open.has(key)) {
          terrain[r][c] = floorBase;
          continue;
        }
        if (isN && isW) terrain[r][c] = G.CORNER_TL;
        else if (isN && isE) terrain[r][c] = G.CORNER_TR;
        else if (isS && isW) terrain[r][c] = G.CORNER_BL;
        else if (isS && isE) terrain[r][c] = G.CORNER_BR;
        else if (isN) terrain[r][c] = G.WALL_NORTH;
        else if (isS) terrain[r][c] = G.WALL_SOUTH;
        else if (isW) terrain[r][c] = G.WALL_WEST;
        else terrain[r][c] = G.WALL_EAST;
      } else {
        // Interior: floor (with optional deterministic accent for visual texture).
        if (floorAccent !== undefined && (r * 7 + c * 3) % 4 === 0) {
          terrain[r][c] = floorAccent;
        } else {
          terrain[r][c] = floorBase;
        }
      }
    }
  }
}

// ── Top-level composer ──────────────────────────────────────────────────────

const SCRIBBLE_TILESET: ComposedTilesetRef = { firstgid: 1, source: '../tilesets/scribble.tsj' };
const WATER_TILESET: ComposedTilesetRef = { firstgid: WATER_FIRSTGID, source: '../tilesets/water.tsj' };

export function composeMap(opts: ComposeOptions): ComposedMap {
  const { width, height, terrain, features } = opts;
  if (width < 12 || height < 8) throw new Error('Map too small (min 12×8)');

  const rng = mulberry32((opts.seed ?? Date.now()) & 0xffffffff);

  if (terrain === 'dungeon') {
    return composeDungeon(width, height, features, rng);
  }

  // Outdoor terrains pull their ground GIDs from the biome's weighted ground
  // pool (grass-dominant with cracked-stone / bumpy variants for texture).
  // Object decoration is added by `applyObjectPool` after feature placement
  // so we don't overwrite features that need clean ground underneath.
  const palette = BIOME_PALETTES[terrain];
  const terrainGrid: number[][] = [];
  const objectGrid: number[][] = [];
  for (let r = 0; r < height; r++) {
    const row: number[] = new Array<number>(width);
    for (let c = 0; c < width; c++) row[c] = pickGroundGid(palette, rng);
    terrainGrid.push(row);
    objectGrid.push(new Array<number>(width).fill(0));
  }

  // Features layer. The coastline carves its footprint first so subsequent
  // feature placers can detect water tiles and avoid them; path runs across
  // the map next; ruins/buildings/campsites stamp on top. Each placer that
  // produces story-relevant locations records them in `anchors`.
  const anchors: MapAnchors = {};
  const usesWater = features.includes('coastline');
  if (features.includes('coastline')) placeCoastline(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('path'))      placePath(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('ruins'))     placeRuins(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('buildings')) placeBuildings(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('campsites')) placeCampsites(terrainGrid, objectGrid, rng, width, height, anchors);

  // Decoration pass — sprinkle palette objects (trees, flowers, …) on the
  // remaining natural ground. Skips cells whose ground GID isn't in the
  // palette's pool (so paths, building floors, water all stay clean), cells
  // already carrying an object, and a 3-row belt along the south edge so
  // the player has clear ground to spawn on.
  applyObjectPool(palette, terrainGrid, objectGrid, rng, width, height);

  const tilesets: ComposedTilesetRef[] = usesWater
    ? [SCRIBBLE_TILESET, WATER_TILESET]
    : [SCRIBBLE_TILESET];

  return {
    width, height,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: composeName(terrain, features),
    description: composeDescription(terrain, features),
    tilesets,
    anchors,
  };
}

/**
 * Run the biome's `objectPool` density rules over the map's natural-ground
 * cells. Skipped:
 *   • cells whose ground GID isn't in the palette's `groundPool` (paths,
 *     stamped building floors, water — anything a feature placer authored);
 *   • cells already carrying an object (campfires, furniture, etc.);
 *   • a 3-row belt along the south edge so the spawn band stays clear.
 *
 * Walls/impassable cells are reported via `isWall` so `wall_adjacent`
 * entries can find them. Trees and the rest of the pool are placed by the
 * shared `rollObjectGid` helper using its clustering rules.
 */
function applyObjectPool(
  palette: BiomePalette,
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
): void {
  if (palette.objectPool.length === 0) return;
  const naturalGround = new Set(palette.groundPool.map((e) => e.gid));
  const isWall = (x: number, y: number): boolean => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    const g = terrain[y][x] & 0x1fffffff;
    return !naturalGround.has(g);
  };
  // Flat row-major view of `objects` for the shared roll helper.
  const flat = new Array<number>(W * H).fill(0);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) flat[r * W + c] = objects[r][c];

  const SOUTH_BUFFER = 3;
  for (let r = 0; r < H - SOUTH_BUFFER; r++) {
    for (let c = 0; c < W; c++) {
      if (objects[r][c] !== 0) continue;
      const ground = terrain[r][c] & 0x1fffffff;
      if (!naturalGround.has(ground)) continue;
      const gid = rollObjectGid(palette, rng, c, r, W, H, flat, isWall);
      if (gid !== 0) {
        objects[r][c] = gid;
        flat[r * W + c] = gid;
      }
    }
  }
}

// ── Feature placers ─────────────────────────────────────────────────────────

/** True iff the given cell's terrain GID belongs to the water tileset
 *  (firstgid=WATER_FIRSTGID, 16 tiles). Feature placers use this to skip
 *  any footprint that would overlap water. */
function isWaterCell(terrain: number[][], r: number, c: number, W: number, H: number): boolean {
  if (r < 0 || r >= H || c < 0 || c >= W) return false;
  const gid = terrain[r][c];
  return gid >= WATER_FIRSTGID && gid < WATER_FIRSTGID + 16;
}

/** True iff any cell in the rectangle [x, x+w) × [y, y+h) is water. */
function rectTouchesWater(terrain: number[][], x: number, y: number, w: number, h: number, W: number, H: number): boolean {
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (isWaterCell(terrain, r, c, W, H)) return true;
    }
  }
  return false;
}

/** True iff the cell's terrain GID is one of the dirt-path tiles laid by
 *  `placePath` (straight runs, corners, intersection — base GIDs 2/16/30
 *  after stripping flip flags). Used by feature placers to reject footprints
 *  that would block the path. */
function isPathCell(terrain: number[][], r: number, c: number, W: number, H: number): boolean {
  if (r < 0 || r >= H || c < 0 || c >= W) return false;
  const base = terrain[r][c] & 0x1fffffff;
  return base === 2 || base === 16 || base === 30;
}

/** True iff any cell in the rectangle [x, x+w) × [y, y+h) is a path tile. */
function rectTouchesPath(terrain: number[][], x: number, y: number, w: number, h: number, W: number, H: number): boolean {
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (isPathCell(terrain, r, c, W, H)) return true;
    }
  }
  return false;
}

function placeRuins(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const count = 2 + Math.floor(rng() * 2);  // 2-3 ruined buildings
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      const w = 6 + Math.floor(rng() * 4);   // 6-9 wide
      const h = 5 + Math.floor(rng() * 3);   // 5-7 tall
      const x = 1 + Math.floor(rng() * Math.max(1, W - w - 2));
      const y = 1 + Math.floor(rng() * Math.max(1, H - h - 2));
      // Skip footprints that overlap coastline water or the path — buildings
      // mustn't cap the road or land in the surf.
      if (rectTouchesWater(terrain, x, y, w, h, W, H)) continue;
      if (rectTouchesPath(terrain, x, y, w, h, W, H)) continue;
      const sides: Doorway['side'][] = ['N', 'S', 'E', 'W'];
      const dwSide = sides[Math.floor(rng() * 4)];
      const wallLen = (dwSide === 'N' || dwSide === 'S') ? w : h;
      const doorways: Doorway[] = [{
        side: dwSide,
        offset: 1 + Math.floor(rng() * Math.max(1, wallLen - 3)),
        length: 1,
      }];
      try {
        stampRoom(terrain, {
          x, y, w, h,
          floorBase: G.STONE_FLOOR,
          floorAccent: G.STONE_FLOOR_CRACKED,
          doorways,
          ruinedBreaks: 2 + Math.floor(rng() * 3),  // 2-4 random wall breaks
          rng,
        });
        // Clear any tree on top of the room footprint (ruined buildings are clearings).
        for (let r = y; r < y + h; r++) {
          for (let c = x; c < x + w; c++) objects[r][c] = 0;
        }
        (anchors.ruins ??= []).push({ x: x + 1, y: y + 1, w: w - 2, h: h - 2 });
        placed = true;
      } catch { /* skip if room overlaps edge */ }
    }
  }
}

function placeBuildings(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const count = 1 + Math.floor(rng() * 2);  // 1-2 intact buildings
  for (let i = 0; i < count; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 12 && !placed; attempt++) {
      const w = 6 + Math.floor(rng() * 3);
      const h = 5 + Math.floor(rng() * 3);
      const x = 1 + Math.floor(rng() * Math.max(1, W - w - 2));
      const y = 1 + Math.floor(rng() * Math.max(1, H - h - 2));
      if (rectTouchesWater(terrain, x, y, w, h, W, H)) continue;
      if (rectTouchesPath(terrain, x, y, w, h, W, H)) continue;
      const sides: Doorway['side'][] = ['N', 'S', 'E', 'W'];
      const dwSide = sides[Math.floor(rng() * 4)];
      const wallLen = (dwSide === 'N' || dwSide === 'S') ? w : h;
      try {
        stampRoom(terrain, {
          x, y, w, h,
          floorBase: G.STONE_FLOOR,
          doorways: [{
            side: dwSide,
            offset: 1 + Math.floor(rng() * Math.max(1, wallLen - 3)),
            length: 1,
          }],
        });
        // Sprinkle some indoor furniture for atmosphere.
        const furniture = [G.CRATE_CLOSED, G.BARRELS_TWO, G.FIREWOOD];
        const numItems = 1 + Math.floor(rng() * 3);
        for (let f = 0; f < numItems; f++) {
          const fx = x + 1 + Math.floor(rng() * (w - 2));
          const fy = y + 1 + Math.floor(rng() * (h - 2));
          objects[fy][fx] = furniture[Math.floor(rng() * furniture.length)];
        }
        // Clear trees from the building footprint.
        for (let r = y; r < y + h; r++) {
          for (let c = x; c < x + w; c++) {
            // Don't clear the placed furniture — only trees that happened to land here.
            if (objects[r][c] === G.TREE) objects[r][c] = 0;
          }
        }
        (anchors.buildings ??= []).push({ x: x + 1, y: y + 1, w: w - 2, h: h - 2 });
        placed = true;
      } catch { /* skip if room overlaps edge */ }
    }
  }
}

function placePath(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  // The path runs from one edge of the map to the opposite edge. Straight
  // runs use PATH_V / PATH_H; every direction change uses a tile-2 corner
  // (one of the four rotations in G) so the trail reads as a continuous
  // dirt road that bends naturally. We pack the cells into a list first,
  // then stamp them in one pass so we can clear any trees underneath.
  type Cell = { x: number; y: number; tile: number };
  const cells: Cell[] = [];
  const horizontal = rng() < 0.5;

  if (horizontal) {
    let r = 2 + Math.floor(rng() * Math.max(1, H - 4));
    let c = 0;
    while (c < W) {
      const lastIsStraight = cells.length > 0 && cells[cells.length - 1].tile === G.PATH_H;
      const canKink = c > 3 && c < W - 4 && lastIsStraight;
      if (canKink && rng() < 0.28) {
        // Two-cell L-bend: enter the current cell going east, exit going N or S,
        // then re-enter the new row going east. Each bend consumes two tiles.
        const goSouth = rng() < 0.5;
        const newR = goSouth ? r + 1 : r - 1;
        if (newR >= 1 && newR < H - 1) {
          cells.push({ x: c, y: r, tile: goSouth ? G.PATH_CORNER_SW : G.PATH_CORNER_NW });
          cells.push({ x: c, y: newR, tile: goSouth ? G.PATH_CORNER_NE : G.PATH_CORNER_SE });
          r = newR;
          c++;
          continue;
        }
      }
      cells.push({ x: c, y: r, tile: G.PATH_H });
      c++;
    }
  } else {
    let c = 2 + Math.floor(rng() * Math.max(1, W - 4));
    let r = 0;
    while (r < H) {
      const lastIsStraight = cells.length > 0 && cells[cells.length - 1].tile === G.PATH_V;
      const canKink = r > 3 && r < H - 4 && lastIsStraight;
      if (canKink && rng() < 0.28) {
        const goEast = rng() < 0.5;
        const newC = goEast ? c + 1 : c - 1;
        if (newC >= 1 && newC < W - 1) {
          cells.push({ x: c, y: r, tile: goEast ? G.PATH_CORNER_NE : G.PATH_CORNER_NW });
          cells.push({ x: newC, y: r, tile: goEast ? G.PATH_CORNER_SW : G.PATH_CORNER_SE });
          c = newC;
          r++;
          continue;
        }
      }
      cells.push({ x: c, y: r, tile: G.PATH_V });
      r++;
    }
  }

  // Record path endpoints — the first and last cells the trail draws are
  // by construction at the map edges, so they're the natural "where a
  // traveller emerges from the woods" anchors. Skip endpoints that fell on
  // water (the path stops at the shore).
  const dry = cells.filter((c) => !isWaterCell(terrain, c.y, c.x, W, H));
  if (dry.length >= 2) {
    anchors.pathEndpoints = [
      { x: dry[0].x, y: dry[0].y },
      { x: dry[dry.length - 1].x, y: dry[dry.length - 1].y },
    ];
  }

  for (const cell of cells) {
    if (cell.x < 0 || cell.x >= W || cell.y < 0 || cell.y >= H) continue;
    // Don't overwrite coastline water — the path stops at the shore.
    if (isWaterCell(terrain, cell.y, cell.x, W, H)) continue;
    terrain[cell.y][cell.x] = cell.tile;
    if (objects[cell.y][cell.x] === G.TREE) objects[cell.y][cell.x] = 0;
  }
}

function placeCampsites(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const count = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < count; i++) {
    let cx = -1, cy = -1;
    // Retry until the campfire centre AND its 3×3 clearing land entirely on
    // dry ground. Bail after a few attempts to keep this O(1) per campsite.
    for (let attempt = 0; attempt < 12; attempt++) {
      const tx = 2 + Math.floor(rng() * (W - 4));
      const ty = 2 + Math.floor(rng() * (H - 4));
      if (!rectTouchesWater(terrain, tx - 1, ty - 1, 3, 3, W, H)) {
        cx = tx;
        cy = ty;
        break;
      }
    }
    if (cx < 0) continue;
    // Campfire in the centre.
    objects[cy][cx] = G.CAMPFIRE;
    (anchors.campfires ??= []).push({ x: cx, y: cy });
    // Clear trees around the campfire to make a small clearing.
    for (let r = Math.max(0, cy - 2); r < Math.min(H, cy + 3); r++) {
      for (let c = Math.max(0, cx - 2); c < Math.min(W, cx + 3); c++) {
        if (objects[r][c] === G.TREE) objects[r][c] = 0;
      }
    }
    // Optional firewood + crate nearby (camp gear).
    const offsets: Array<[number, number, number]> = [
      [-1, 0, G.FIREWOOD],
      [ 1, 0, G.CRATE_CLOSED],
    ];
    for (const [dx, dy, gid] of offsets) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H && objects[y][x] === 0 && terrain[y][x] === G.GRASS) {
        objects[y][x] = gid;
      }
    }
  }
}

// ── Water features (coastline) ──────────────────────────────────────────────
//
// The coastline cuts a uniform-depth strip of water along one randomly chosen
// edge of the map. The water side is filled with the open-water tile; the
// single row of water cells nearest the dry land uses the matching
// `WATER_EDGE_<grass side>` tile so the shoreline reads as a continuous wave
// line. There are no outer/inner corner tiles — the coastline is straight.

function placeCoastline(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const sides = ['N', 'E', 'S', 'W'] as const;
  const side = sides[Math.floor(rng() * 4)];
  const depth = side === 'N' || side === 'S' ? Math.max(3, Math.floor(H * 0.4)) : Math.max(3, Math.floor(W * 0.4));

  // Paint the rectangle of water cells; for cells in the row/col farthest
  // from the map edge (the shoreline row) use the matching WATER_EDGE_<dir>
  // tile, where <dir> is the grass side — i.e. for a north coastline the
  // shoreline cells have grass to their south, so they get WATER_EDGE_S.
  const fillCol = (r: number, edgeTile: number, fillTile: number, isShoreline: boolean) => {
    for (let c = 0; c < W; c++) {
      objects[r][c] = 0;
      terrain[r][c] = isShoreline ? edgeTile : fillTile;
    }
  };
  const fillRow = (c: number, edgeTile: number, fillTile: number, isShoreline: boolean) => {
    for (let r = 0; r < H; r++) {
      objects[r][c] = 0;
      terrain[r][c] = isShoreline ? edgeTile : fillTile;
    }
  };

  if (side === 'N') {
    for (let r = 0; r < depth; r++) fillCol(r, G.WATER_EDGE_S, G.WATER, r === depth - 1);
  } else if (side === 'S') {
    for (let r = H - depth; r < H; r++) fillCol(r, G.WATER_EDGE_N, G.WATER, r === H - depth);
  } else if (side === 'W') {
    for (let c = 0; c < depth; c++) fillRow(c, G.WATER_EDGE_E, G.WATER, c === depth - 1);
  } else {
    for (let c = W - depth; c < W; c++) fillRow(c, G.WATER_EDGE_W, G.WATER, c === W - depth);
  }

  // Record a thin inland band on the opposite (dry) edge — that's where a
  // traveller approaches the coast from. The randomizer uses this so the
  // player party doesn't spawn standing in the surf.
  const band: Array<{ x: number; y: number }> = [];
  if (side === 'N') {
    for (let c = 0; c < W; c++) for (let i = 0; i < 3; i++) band.push({ x: c, y: H - 1 - i });
  } else if (side === 'S') {
    for (let c = 0; c < W; c++) for (let i = 0; i < 3; i++) band.push({ x: c, y: i });
  } else if (side === 'W') {
    for (let r = 0; r < H; r++) for (let i = 0; i < 3; i++) band.push({ x: W - 1 - i, y: r });
  } else {
    for (let r = 0; r < H; r++) for (let i = 0; i < 3; i++) band.push({ x: i, y: r });
  }
  anchors.inlandBand = band;
}

// ── Dungeon generator ────────────────────────────────────────────────────────
//
// `dungeon` terrain is fundamentally different from outdoor terrain: every
// cell starts impassable, and rooms + corridors are carved out. The 3-room /
// 5-room features control how many chambers are placed; their shapes and
// positions are drawn from a small library of fixed layouts so the result
// fits inside a 30×22 default canvas without needing complex BSP logic.
//
// The dungeon entry is a single passable cell on the southern edge that
// extends into the southernmost room — players enter from off-map.

function composeDungeon(W: number, H: number, features: Feature[], rng: () => number): ComposedMap {
  const terrainGrid: number[][] = [];
  const objectGrid: number[][] = [];
  for (let r = 0; r < H; r++) {
    terrainGrid.push(new Array<number>(W).fill(0));   // GID 0 = impassable void
    objectGrid.push(new Array<number>(W).fill(0));
  }

  // Floor mask (true = carved). Walls are derived after carving.
  const floor: boolean[][] = Array.from({ length: H }, () => new Array<boolean>(W).fill(false));

  // Pick the room count. Default to 3 rooms when neither flag is set so the
  // dungeon still resolves to something.
  const roomCount = features.includes('5-room') ? 5 : 3;

  // Lay out non-overlapping rooms inside the playable area, leaving a 1-tile
  // void margin around the map edge for walls.
  const rooms: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }> = [];
  const maxAttempts = 80;
  while (rooms.length < roomCount) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
      const w = 4 + Math.floor(rng() * 4);   // 4-7 wide
      const h = 4 + Math.floor(rng() * 3);   // 4-6 tall
      const x = 2 + Math.floor(rng() * (W - w - 4));
      const y = 2 + Math.floor(rng() * (H - h - 4));
      const overlap = rooms.some((r) =>
        x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y,
      );
      if (overlap) continue;
      rooms.push({ x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2) });
      placed = true;
    }
    if (!placed) break; // give up — limited canvas can't fit any more rooms
  }

  // Carve each room's floor.
  for (const r of rooms) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        floor[r.y + dy][r.x + dx] = true;
      }
    }
  }

  // Sort rooms by centre so corridors form a vaguely linear chain rather than
  // crossing themselves. Connect each consecutive pair with an L-shaped
  // corridor (1 tile wide).
  rooms.sort((a, b) => (a.cy + a.cx) - (b.cy + b.cx));
  for (let i = 1; i < rooms.length; i++) {
    carveCorridor(floor, rooms[i - 1].cx, rooms[i - 1].cy, rooms[i].cx, rooms[i].cy);
  }

  // Pick the southernmost room and punch an entry corridor from its south
  // wall to the southern map edge.
  let entryRoom = rooms[0];
  for (const r of rooms) {
    if (r.y + r.h > entryRoom.y + entryRoom.h) entryRoom = r;
  }
  if (entryRoom) {
    const entryX = entryRoom.x + Math.floor(entryRoom.w / 2);
    for (let r = entryRoom.y + entryRoom.h; r < H; r++) floor[r][entryX] = true;
  }

  // Paint floor + walls. A wall sits at any non-floor cell adjacent to at
  // least one floor cell (orthogonally OR diagonally — diagonal-only neighbours
  // are the room's outer corners). Pick the wall art so its visible surface
  // faces OUTWARD from the room interior, matching the convention used by
  // `stampRoom` for outdoor buildings:
  //   • one orthogonal floor neighbour → straight wall along the room's edge
  //   • two perpendicular orthogonal floor neighbours → inner room corner
  //   • diagonal-only floor neighbour → outer room corner
  //
  // Floor tiles are sampled from the dungeon biome's ground pool so the
  // stone-floor texture varies cell-to-cell (cracked / diamond / inlay
  // sprinkled into the base stone).
  const dungeonPalette = BIOME_PALETTES.dungeon;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      if (floor[r][c]) {
        terrainGrid[r][c] = pickGroundGid(dungeonPalette, rng);
        continue;
      }
      const fN  = !!floor[r - 1]?.[c];
      const fS  = !!floor[r + 1]?.[c];
      const fE  = !!floor[r]?.[c + 1];
      const fW  = !!floor[r]?.[c - 1];
      const fNW = !!floor[r - 1]?.[c - 1];
      const fNE = !!floor[r - 1]?.[c + 1];
      const fSW = !!floor[r + 1]?.[c - 1];
      const fSE = !!floor[r + 1]?.[c + 1];

      // CONCAVE corner — two perpendicular orthogonal floors. The room
      // wraps around the wall tile on those two sides, so the wall sits in
      // a single quadrant of the tile (the corner OPPOSITE the room) while
      // the rest of the tile shows floor. `stone_wall_corner_ul` and its
      // rotations cover all four quadrants. E.g. floor S+E → room is at
      // SE → wall occupies the NW quadrant → PARTIAL_CORNER_UL.
      if (fS && fE)      terrainGrid[r][c] = G.PARTIAL_CORNER_UL;
      else if (fS && fW) terrainGrid[r][c] = G.PARTIAL_CORNER_UR;
      else if (fN && fE) terrainGrid[r][c] = G.PARTIAL_CORNER_LL;
      else if (fN && fW) terrainGrid[r][c] = G.PARTIAL_CORNER_LR;
      // One orthogonal floor → straight wall facing outward.
      else if (fS) terrainGrid[r][c] = G.WALL_NORTH;
      else if (fN) terrainGrid[r][c] = G.WALL_SOUTH;
      else if (fE) terrainGrid[r][c] = G.WALL_WEST;
      else if (fW) terrainGrid[r][c] = G.WALL_EAST;
      // CONVEX corner — diagonal-only floor (the four corners of a
      // rectangular room as `stampRoom` produces them for the ruins map).
      // The wall corner points AWAY from the room interior.
      else if (fSE) terrainGrid[r][c] = G.CORNER_TL;
      else if (fSW) terrainGrid[r][c] = G.CORNER_TR;
      else if (fNE) terrainGrid[r][c] = G.CORNER_BL;
      else if (fNW) terrainGrid[r][c] = G.CORNER_BR;
    }
  }

  // Build the dungeon anchors. The southernmost room (`entryRoom`) is the
  // entrance; the room farthest from it (by Manhattan distance between
  // centers) is the vault.
  const anchors: MapAnchors = {
    rooms: rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, cx: r.cx, cy: r.cy })),
  };
  if (entryRoom) {
    anchors.entrance = { x: entryRoom.cx, y: entryRoom.cy };
    let vault = entryRoom;
    let best = -1;
    for (const r of rooms) {
      const d = Math.abs(r.cx - entryRoom.cx) + Math.abs(r.cy - entryRoom.cy);
      if (d > best) { best = d; vault = r; }
    }
    anchors.vault = { x: vault.cx, y: vault.cy };
  }

  return {
    width: W,
    height: H,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: roomCount === 5 ? 'Five-Chamber Dungeon' : 'Three-Chamber Dungeon',
    description: `A stone dungeon of ${roomCount} rooms linked by short corridors. The entrance opens onto the southern edge of the map.`,
    tilesets: [SCRIBBLE_TILESET],
    anchors,
  };
}

function carveCorridor(floor: boolean[][], x1: number, y1: number, x2: number, y2: number): void {
  // L-shaped: walk horizontally first then vertically (or vice versa).
  const cols = floor[0].length;
  const rows = floor.length;
  const horizFirst = (x1 + y1) % 2 === 0;
  if (horizFirst) {
    const [a, b] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let c = a; c <= b; c++) if (y1 >= 0 && y1 < rows && c >= 0 && c < cols) floor[y1][c] = true;
    const [c, d] = y1 < y2 ? [y1, y2] : [y2, y1];
    for (let r = c; r <= d; r++) if (r >= 0 && r < rows && x2 >= 0 && x2 < cols) floor[r][x2] = true;
  } else {
    const [a, b] = y1 < y2 ? [y1, y2] : [y2, y1];
    for (let r = a; r <= b; r++) if (r >= 0 && r < rows && x1 >= 0 && x1 < cols) floor[r][x1] = true;
    const [c, d] = x1 < x2 ? [x1, x2] : [x2, x1];
    for (let cc = c; cc <= d; cc++) if (y2 >= 0 && y2 < rows && cc >= 0 && cc < cols) floor[y2][cc] = true;
  }
}

// ── Naming + helpers ────────────────────────────────────────────────────────

const FEATURE_ADJ: Partial<Record<Feature, string>> = {
  ruins: 'Ruined',
  buildings: 'Settled',
  campsites: 'Camped',
  coastline: 'Coastal',
};

function composeName(terrain: Terrain, features: Feature[]): string {
  if (terrain === 'dungeon') return features.includes('5-room') ? 'Five-Chamber Dungeon' : 'Three-Chamber Dungeon';
  const t = terrain === 'forest' ? 'Forest' : 'Field';
  if (features.length === 0) return t;
  const adj = FEATURE_ADJ[features[0]];
  return adj ? `${adj} ${t}` : t;
}

function composeDescription(terrain: Terrain, features: Feature[]): string {
  if (terrain === 'dungeon') {
    const n = features.includes('5-room') ? 'five' : 'three';
    return `A stone dungeon of ${n} rooms linked by short corridors. The entrance opens onto the southern edge of the map.`;
  }
  const base = terrain === 'forest'
    ? 'A wooded clearing under thick canopy.'
    : 'Open grassland stretches across the map.';
  const tail = features.length === 0 ? '' :
    features.length === 1 ? ` Scattered ${features[0]} dot the area.` :
    ` ${features.map(f => `${f.charAt(0).toUpperCase()}${f.slice(1)}`).join(', ')} share the ground here.`;
  return base + tail;
}

function flatten(grid: number[][]): number[] {
  const out: number[] = [];
  for (const row of grid) out.push(...row);
  return out;
}

/** Mulberry32 — small deterministic 32-bit PRNG. Returns a [0, 1) float per call. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0)) / 4294967296;
  };
}
