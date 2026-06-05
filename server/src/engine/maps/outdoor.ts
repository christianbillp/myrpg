/**
 * Outdoor composer — grassland and forest terrains with optional features
 * (coastline / path / intersection / buildings / campsites).
 *
 * Every cell starts as a biome-palette ground tile (grass-dominant) and
 * features layer on top:
 *   1. Coastline carves a water strip on a random edge (so subsequent
 *      placers can detect water and avoid it).
 *   2. Path / intersection stamps dirt paths on the object layer (terrain
 *      stays as natural ground), emitting `path` / `intersection` zones.
 *   3. Buildings stamp stone-floor rectangles with transparent walls on the
 *      object layer, emitting `building <n>` zones each.
 *   4. Campsites scatter campfires on dry ground.
 *   5. A final decoration pass sprinkles palette objects (trees, flowers)
 *      on every untouched natural-ground cell.
 *
 * All feature placers respect a shared `reserved: Set<string>` so a path
 * never overlaps a building and vice versa.
 */
import { BIOME_PALETTES, pickGroundGid, rollObjectGid, type BiomePalette } from '../../../../shared/biomePalettes.js';
import type { ComposedMap, ComposedTilesetRef, Feature, MapAnchors, MapZone, StructureSpec, Terrain } from '../mapTypes.js';
import { DECOR_GIDS, EDGE_ROTATION, FURNITURE_GIDS, PATH_GIDS, RUIN_WALL_GIDS, TERRAIN_GIDS, WALL_GIDS, WATER_FIRSTGID, WATER_GIDS } from '../mapTiles.js';
import { SCRIBBLE_TILESET, WATER_TILESET, flatten } from './shared.js';

export interface ComposeOutdoorOpts {
  width: number;
  height: number;
  terrain: 'grassland' | 'forest';
  features: Feature[];
  structures?: StructureSpec[];
  rng: () => number;
  allocZoneId: (kind: string) => string;
}

export function composeOutdoor(opts: ComposeOutdoorOpts): ComposedMap {
  const { width, height, terrain, features, rng, allocZoneId } = opts;
  const palette = BIOME_PALETTES[terrain];

  // Terrain layer — fill with the biome's natural ground.
  const terrainGrid: number[][] = [];
  const objectGrid: number[][]  = [];
  for (let r = 0; r < height; r++) {
    const row: number[] = new Array<number>(width);
    for (let c = 0; c < width; c++) row[c] = pickGroundGid(palette, rng);
    terrainGrid.push(row);
    objectGrid.push(new Array<number>(width).fill(0));
  }

  // Feature placement. Coastline first so other placers can detect water;
  // paths next (they paint object-layer tiles); buildings next (avoid path
  // cells via the shared `reserved` set); campsites last.
  const anchors: MapAnchors = {};
  const zones: MapZone[] = [];
  const reserved = new Set<string>();
  const usesWater = features.includes('coastline');
  if (usesWater) placeCoastline(terrainGrid, objectGrid, rng, width, height, anchors);
  if (features.includes('path') || features.includes('intersection')) {
    placePath(terrainGrid, objectGrid, rng, width, height, anchors, zones, reserved, allocZoneId, {
      intersection: features.includes('intersection'),
      coastline: usesWater,
    });
  }
  // Structures — each configured spec stamped as a connected multi-room
  // building / ruin, numbered per type for its zone label.
  let buildingIdx = 0, ruinIdx = 0;
  for (const spec of opts.structures ?? []) {
    const idx = spec.type === 'ruin' ? ++ruinIdx : ++buildingIdx;
    stampStructure(terrainGrid, objectGrid, rng, width, height, spec, anchors, zones, reserved, allocZoneId, idx);
  }
  if (features.includes('campsites')) placeCampsites(terrainGrid, objectGrid, rng, width, height, anchors);

  applyObjectPool(palette, terrainGrid, objectGrid, rng, width, height);

  const tilesets: ComposedTilesetRef[] = usesWater ? [SCRIBBLE_TILESET, WATER_TILESET] : [SCRIBBLE_TILESET];
  return {
    width, height,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: composeOutdoorName(terrain, features, opts.structures ?? []),
    description: composeOutdoorDescription(terrain, features, opts.structures ?? [], anchors, width, height),
    tilesets,
    anchors,
    ...(zones.length > 0 ? { zones } : {}),
  };
}

// ── Decoration pass ─────────────────────────────────────────────────────────

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

// ── Water helpers + coastline ──────────────────────────────────────────────

function isWaterCell(terrain: number[][], r: number, c: number, W: number, H: number): boolean {
  if (r < 0 || r >= H || c < 0 || c >= W) return false;
  const gid = terrain[r][c];
  return gid >= WATER_FIRSTGID && gid < WATER_FIRSTGID + 16;
}

function rectTouchesWater(terrain: number[][], x: number, y: number, w: number, h: number, W: number, H: number): boolean {
  for (let r = y; r < y + h; r++) {
    for (let c = x; c < x + w; c++) {
      if (isWaterCell(terrain, r, c, W, H)) return true;
    }
  }
  return false;
}

function placeCoastline(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const sides = ['N', 'E', 'S', 'W'] as const;
  const side = sides[Math.floor(rng() * 4)];
  const depth = side === 'N' || side === 'S' ? Math.max(3, Math.floor(H * 0.4)) : Math.max(3, Math.floor(W * 0.4));

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
    for (let r = 0; r < depth; r++) fillCol(r, WATER_GIDS.EDGE_S, WATER_GIDS.WATER, r === depth - 1);
  } else if (side === 'S') {
    for (let r = H - depth; r < H; r++) fillCol(r, WATER_GIDS.EDGE_N, WATER_GIDS.WATER, r === H - depth);
  } else if (side === 'W') {
    for (let c = 0; c < depth; c++) fillRow(c, WATER_GIDS.EDGE_E, WATER_GIDS.WATER, c === depth - 1);
  } else {
    for (let c = W - depth; c < W; c++) fillRow(c, WATER_GIDS.EDGE_W, WATER_GIDS.WATER, c === W - depth);
  }

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

// ── Path placer ────────────────────────────────────────────────────────────

function placePath(
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
  anchors: MapAnchors,
  zones: MapZone[],
  reserved: Set<string>,
  allocZoneId: (kind: string) => string,
  opts: { intersection: boolean; coastline: boolean },
): void {
  const pathCells = new Set<string>();
  const paint = (x: number, y: number): boolean => {
    if (x < 0 || x >= W || y < 0 || y >= H) return false;
    if (isWaterCell(terrain, y, x, W, H)) return false;
    pathCells.add(`${x},${y}`);
    reserved.add(`${x},${y}`);
    return true;
  };
  const edgePoint = (x: number, y: number): { x: number; y: number } | null =>
    (x >= 0 && x < W && y >= 0 && y < H && !isWaterCell(terrain, y, x, W, H)) ? { x, y } : null;

  const endpoints: Array<{ x: number; y: number }> = [];

  if (opts.intersection && opts.coastline) {
    const band = anchors.inlandBand;
    let cx = W / 2, cy = H / 2;
    if (band && band.length > 0) {
      cx = band.reduce((s, p) => s + p.x, 0) / band.length;
      cy = band.reduce((s, p) => s + p.y, 0) / band.length;
    }
    const horizDist = Math.min(cx, W - 1 - cx);
    const vertDist  = Math.min(cy, H - 1 - cy);
    const spineHorizontal = vertDist < horizDist;
    if (spineHorizontal) {
      const spineRow = Math.max(2, Math.min(H - 3, Math.round(cy)));
      const stemCol  = 3 + Math.floor(rng() * Math.max(1, W - 6));
      for (let x = 0; x < W; x++) paint(x, spineRow);
      const waterIsSouth = cy < H / 2;
      const step = waterIsSouth ? 1 : -1;
      let y = spineRow + step;
      while (y >= 0 && y < H && paint(stemCol, y)) y += step;
      anchors.pathIntersection = { x: stemCol, y: spineRow };
      const left  = edgePoint(0, spineRow);
      const right = edgePoint(W - 1, spineRow);
      const stemEnd = edgePoint(stemCol, y - step);
      for (const p of [left, right, stemEnd]) if (p) endpoints.push(p);
    } else {
      const spineCol = Math.max(2, Math.min(W - 3, Math.round(cx)));
      const stemRow  = 3 + Math.floor(rng() * Math.max(1, H - 6));
      for (let y = 0; y < H; y++) paint(spineCol, y);
      const waterIsEast = cx < W / 2;
      const step = waterIsEast ? 1 : -1;
      let x = spineCol + step;
      while (x >= 0 && x < W && paint(x, stemRow)) x += step;
      anchors.pathIntersection = { x: spineCol, y: stemRow };
      const top    = edgePoint(spineCol, 0);
      const bottom = edgePoint(spineCol, H - 1);
      const stemEnd = edgePoint(x - step, stemRow);
      for (const p of [top, bottom, stemEnd]) if (p) endpoints.push(p);
    }
  } else if (opts.intersection) {
    const row = 3 + Math.floor(rng() * Math.max(1, H - 6));
    const col = 3 + Math.floor(rng() * Math.max(1, W - 6));
    for (let x = 0; x < W; x++) paint(x, row);
    for (let y = 0; y < H; y++) paint(col, y);
    anchors.pathIntersection = { x: col, y: row };
    for (const p of [edgePoint(0, row), edgePoint(W - 1, row), edgePoint(col, 0), edgePoint(col, H - 1)]) {
      if (p) endpoints.push(p);
    }
  } else {
    const horizontal = rng() < 0.5;
    if (horizontal) {
      const row = 3 + Math.floor(rng() * Math.max(1, H - 6));
      for (let x = 0; x < W; x++) paint(x, row);
      for (const p of [edgePoint(0, row), edgePoint(W - 1, row)]) if (p) endpoints.push(p);
    } else {
      const col = 3 + Math.floor(rng() * Math.max(1, W - 6));
      for (let y = 0; y < H; y++) paint(col, y);
      for (const p of [edgePoint(col, 0), edgePoint(col, H - 1)]) if (p) endpoints.push(p);
    }
  }

  if (pathCells.size === 0) return;

  // Second pass: pick the right path GID + rotation per cell from its
  // 4-neighbour mask in pathCells. T-junctions fall back to the 4-way
  // intersection tile since the spritesheet has no dedicated T tile.
  const inPath = (x: number, y: number): boolean => pathCells.has(`${x},${y}`);
  for (const cell of pathCells) {
    const [sx, sy] = cell.split(',');
    const x = parseInt(sx, 10), y = parseInt(sy, 10);
    const n = inPath(x, y - 1), s = inPath(x, y + 1);
    const e = inPath(x + 1, y), w = inPath(x - 1, y);
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
    objects[y][x] = gid;
  }

  anchors.pathEndpoints = endpoints;
  zones.push({ id: allocZoneId('path'), name: 'path', color: '#cc9966', cells: [...pathCells].sort() });
  if (anchors.pathIntersection) {
    const i = anchors.pathIntersection;
    zones.push({ id: allocZoneId('intersection'), name: 'intersection', color: '#ffaa44', cells: [`${i.x},${i.y}`] });
  }
}

// ── Structure stamper (configurable multi-room buildings + ruins) ───────────

interface Rect { x: number; y: number; w: number; h: number; }

/** Per non-corner ruin wall segment: a band for "broken out" (a gap), then a
 *  band each for a cracked wall and a rubble wall — ruins are mostly solid with
 *  crumbling segments here and there. */
const RUIN_BREAK_CHANCE = 0.12;
const RUIN_VARIANT_BAND = 0.12;
/** Probability a ruin floor cell is cracked stone rather than clean. */
const RUIN_CRACK_CHANCE = 0.35;

/** Doorway rotation for a wall cell, from which sides have floor. */
function doorRotation(fN: boolean, fS: boolean, fE: boolean, fW: boolean): number {
  if (fE && fW) return EDGE_ROTATION.W;   // vertical wall between two rooms
  if (fN && fS) return EDGE_ROTATION.S;   // horizontal wall between two rooms
  if (fN) return EDGE_ROTATION.S;          // floor to the north → south-facing wall
  if (fS) return EDGE_ROTATION.N;
  if (fE) return EDGE_ROTATION.W;
  return EDGE_ROTATION.E;
}

/**
 * Stamp one configurable structure: `spec.rooms` (1..5) rectangular rooms laid
 * in a row (horizontal or vertical), separated by a single shared wall and
 * linked through it by a doorway, plus one external entrance doorway. Walls are
 * rendered from an 8-neighbour floor mask (like the dungeon), so single rooms
 * and multi-room junctions both get correct corner/straight tiles. A `ruin`
 * cracks its floor and crumbles some straight wall segments.
 *
 * Degrades gracefully: if `rooms` can't fit, it retries with fewer. Emits a
 * `building <idx>` / `ruin <idx>` zone and records room footprints on `anchors`.
 */
function stampStructure(
  terrain: number[][],
  objects: number[][],
  rng: () => number,
  W: number, H: number,
  spec: StructureSpec,
  anchors: MapAnchors,
  zones: MapZone[],
  reserved: Set<string>,
  allocZoneId: (kind: string) => string,
  idx: number,
): void {
  const ruined = spec.type === 'ruin';
  const floorGid = (): number => ruined && rng() < RUIN_CRACK_CHANCE ? TERRAIN_GIDS.STONE_FLOOR_CRACKED : TERRAIN_GIDS.STONE_FLOOR;

  /** Whole-footprint (+1 border) free of bounds/water/reserved. */
  const boxFree = (x: number, y: number, w: number, h: number): boolean => {
    for (let r = y - 1; r <= y + h; r++) {
      for (let c = x - 1; c <= x + w; c++) {
        if (c < 0 || c >= W || r < 0 || r >= H) return false;
        if (isWaterCell(terrain, r, c, W, H) || reserved.has(`${c},${r}`)) return false;
      }
    }
    return true;
  };

  for (let want = Math.max(1, Math.min(5, Math.floor(spec.rooms))); want >= 1; want--) {
    // Arrange the rooms in a compact grid (uniform room size so shared walls
    // line up) rather than a single long row — so even 5 rooms fit on the map.
    const rw = 4 + Math.floor(rng() * 3);  // 4..6 (uniform within this structure)
    const rh = 4 + Math.floor(rng() * 2);  // 4..5
    const cols = Math.ceil(Math.sqrt(want));
    const gridRows = Math.ceil(want / cols);
    const bw = cols * (rw + 1) - 1;        // +1 shared wall between columns
    const bh = gridRows * (rh + 1) - 1;
    if (bw > W - 2 || bh > H - 2) continue;

    let bx = -1, by = -1;
    for (let a = 0; a < 50; a++) {
      const tx = 1 + Math.floor(rng() * (W - bw - 1));
      const ty = 1 + Math.floor(rng() * (H - bh - 1));
      if (boxFree(tx, ty, bw, bh)) { bx = tx; by = ty; break; }
    }
    if (bx < 0) continue;

    // Lay rooms row-major; link each to its left neighbour (or the room above
    // when it starts a new grid row) through a shared-wall doorway → a spanning
    // tree that keeps every room reachable.
    const rooms: Rect[] = [];
    const doorSet = new Set<string>();
    for (let i = 0; i < want; i++) {
      const col = i % cols, row = Math.floor(i / cols);
      const rx = bx + col * (rw + 1), ry = by + row * (rh + 1);
      rooms.push({ x: rx, y: ry, w: rw, h: rh });
      if (i > 0 && col > 0) {
        // door in the vertical shared wall to the left neighbour
        doorSet.add(`${rx - 1},${ry + 1 + Math.floor(rng() * (rh - 2))}`);
      } else if (i > 0) {
        // first room of a new row: door in the horizontal shared wall above
        doorSet.add(`${rx + 1 + Math.floor(rng() * (rw - 2))},${ry - 1}`);
      }
    }
    // External entrance: a doorway in room 0's north outer wall.
    const r0 = rooms[0];
    doorSet.add(`${r0.x + (r0.w >> 1)},${r0.y - 1}`);

    const floor = new Set<string>();
    for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) floor.add(`${x},${y}`);
    const isFloor = (x: number, y: number): boolean => floor.has(`${x},${y}`);

    // Render floor + walls over the footprint (rooms plus their 1-cell border).
    const cells: string[] = [];
    for (let y = by - 1; y <= by + bh; y++) {
      for (let x = bx - 1; x <= bx + bw; x++) {
        const key = `${x},${y}`;
        if (isFloor(x, y)) { terrain[y][x] = floorGid(); reserved.add(key); cells.push(key); continue; }
        const fN = isFloor(x, y - 1), fS = isFloor(x, y + 1), fE = isFloor(x + 1, y), fW = isFloor(x - 1, y);
        const fNW = isFloor(x - 1, y - 1), fNE = isFloor(x + 1, y - 1), fSW = isFloor(x - 1, y + 1), fSE = isFloor(x + 1, y + 1);
        if (!(fN || fS || fE || fW || fNW || fNE || fSW || fSE)) continue; // not a wall of this structure
        terrain[y][x] = floorGid();
        reserved.add(key);
        cells.push(key);
        if (doorSet.has(key)) { objects[y][x] = FURNITURE_GIDS.DOORWAY + doorRotation(fN, fS, fE, fW); continue; }
        // Concave (room wraps two perpendicular sides) — solid junction corner.
        if (fS && fE)      { objects[y][x] = WALL_GIDS.PARTIAL_CORNER_UL; continue; }
        if (fS && fW)      { objects[y][x] = WALL_GIDS.PARTIAL_CORNER_UR; continue; }
        if (fN && fE)      { objects[y][x] = WALL_GIDS.PARTIAL_CORNER_LL; continue; }
        if (fN && fW)      { objects[y][x] = WALL_GIDS.PARTIAL_CORNER_LR; continue; }
        // Straight wall — one orthogonal floor neighbour. Ruins vary these.
        if (fN || fS || fE || fW) {
          const rot = fS ? EDGE_ROTATION.N : fN ? EDGE_ROTATION.S : fE ? EDGE_ROTATION.W : EDGE_ROTATION.E;
          if (ruined) {
            const roll = rng();
            if (roll < RUIN_BREAK_CHANCE) continue;                                                  // broken out → gap
            if (roll < RUIN_BREAK_CHANCE + RUIN_VARIANT_BAND)     { objects[y][x] = RUIN_WALL_GIDS.CRACKED + rot; continue; }
            if (roll < RUIN_BREAK_CHANCE + 2 * RUIN_VARIANT_BAND) { objects[y][x] = RUIN_WALL_GIDS.BROKEN + rot; continue; }
          }
          objects[y][x] = fS ? WALL_GIDS.NORTH : fN ? WALL_GIDS.SOUTH : fE ? WALL_GIDS.WEST : WALL_GIDS.EAST;
          continue;
        }
        // Convex outer corner — diagonal-only floor neighbour.
        if (fSE)      objects[y][x] = WALL_GIDS.CORNER_TL;
        else if (fSW) objects[y][x] = WALL_GIDS.CORNER_TR;
        else if (fNE) objects[y][x] = WALL_GIDS.CORNER_BL;
        else          objects[y][x] = WALL_GIDS.CORNER_BR;
      }
    }

    anchors.buildings = [...(anchors.buildings ?? []), ...rooms];
    const kind = ruined ? 'ruin' : 'building';
    const color = ruined ? '#776655' : '#8866cc';
    zones.push({ id: allocZoneId(`${kind}_${idx}`), name: `${kind} ${idx}`, color, cells: cells.sort() });
    return;
  }
}

// ── Campsites ──────────────────────────────────────────────────────────────

function placeCampsites(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number, anchors: MapAnchors): void {
  const count = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < count; i++) {
    let cx = -1, cy = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const tx = 2 + Math.floor(rng() * (W - 4));
      const ty = 2 + Math.floor(rng() * (H - 4));
      if (!rectTouchesWater(terrain, tx - 1, ty - 1, 3, 3, W, H)) { cx = tx; cy = ty; break; }
    }
    if (cx < 0) continue;
    objects[cy][cx] = DECOR_GIDS.CAMPFIRE;
    (anchors.campfires ??= []).push({ x: cx, y: cy });
    for (let r = Math.max(0, cy - 2); r < Math.min(H, cy + 3); r++) {
      for (let c = Math.max(0, cx - 2); c < Math.min(W, cx + 3); c++) {
        if (objects[r][c] === DECOR_GIDS.TREE) objects[r][c] = 0;
      }
    }
    const offsets: Array<[number, number, number]> = [
      [-1, 0, DECOR_GIDS.FIREWOOD],
      [ 1, 0, DECOR_GIDS.CRATE_CLOSED],
    ];
    for (const [dx, dy, gid] of offsets) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < W && y >= 0 && y < H && objects[y][x] === 0 && terrain[y][x] === TERRAIN_GIDS.GRASS) {
        objects[y][x] = gid;
      }
    }
  }
}

// ── Naming + description (outdoor only) ────────────────────────────────────

const FEATURE_ADJ: Partial<Record<Feature, string>> = {
  campsites:    'Camped',
  coastline:    'Coastal',
  path:         'Wayside',
  intersection: 'Crossroads',
};

function composeOutdoorName(terrain: 'grassland' | 'forest', features: Feature[], structures: StructureSpec[]): string {
  const t = terrain === 'forest' ? 'Forest' : 'Field';
  if (features.length > 0) {
    const adj = FEATURE_ADJ[features[0]];
    if (adj) return `${adj} ${t}`;
  }
  if (structures.length > 0) {
    const onlyRuins = structures.every((s) => s.type === 'ruin');
    return `${onlyRuins ? 'Ruined' : 'Settled'} ${t}`;
  }
  return t;
}

function composeOutdoorDescription(terrain: Terrain, features: Feature[], structures: StructureSpec[], anchors: MapAnchors, W: number, H: number): string {
  const base = terrain === 'forest'
    ? 'A wooded clearing under thick canopy.'
    : 'Open grassland stretches across the map.';
  const layout: string[] = [];
  if (features.includes('coastline')) layout.push(`Water along the ${waterSide(anchors, W, H)} edge of the map`);
  if (features.includes('path') || features.includes('intersection')) {
    if (anchors.pathIntersection) {
      layout.push(features.includes('coastline') ? 'a T-junction meets a single dirt path' : 'two dirt paths cross at an intersection');
    } else {
      layout.push('a dirt path runs across the map');
    }
  }
  const nBuild = structures.filter((s) => s.type === 'building').length;
  const nRuin = structures.filter((s) => s.type === 'ruin').length;
  if (nBuild > 0) layout.push(plural(nBuild, 'building'));
  if (nRuin > 0) layout.push(plural(nRuin, 'ruin'));
  if (features.includes('campsites')) {
    const n = anchors.campfires?.length ?? 0;
    const where = listPositions(anchors.campfires, W, H);
    layout.push(`${plural(n, 'campfire')}${where ? ` at the ${where}` : ''}`);
  }
  if (layout.length === 0) return base;
  const detailLine = layout.map((s, i) => i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s).join('; ');
  return `${base} ${detailLine}.`;
}

function cardinal(rect: { x: number; y: number; w: number; h: number }, W: number, H: number): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const thirdX = W / 3;
  const thirdY = H / 3;
  const horiz = cx < thirdX ? 'west' : cx > 2 * thirdX ? 'east' : '';
  const vert  = cy < thirdY ? 'north' : cy > 2 * thirdY ? 'south' : '';
  if (vert && horiz) return `${vert}-${horiz}`;
  if (vert)  return vert;
  if (horiz) return horiz;
  return 'centre';
}

function listPositions(items: Array<{ x: number; y: number; w?: number; h?: number }> | undefined, W: number, H: number): string {
  if (!items || items.length === 0) return '';
  const labels = items.map((it) => cardinal({ x: it.x, y: it.y, w: it.w ?? 0, h: it.h ?? 0 }, W, H));
  const unique: string[] = [];
  for (const l of labels) if (!unique.includes(l)) unique.push(l);
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

function waterSide(anchors: MapAnchors, W: number, H: number): string {
  const band = anchors.inlandBand;
  if (!band || band.length === 0) return 'one edge';
  let sumX = 0, sumY = 0;
  for (const c of band) { sumX += c.x; sumY += c.y; }
  const cx = sumX / band.length;
  const cy = sumY / band.length;
  const dxFromCenter = cx - W / 2;
  const dyFromCenter = cy - H / 2;
  if (Math.abs(dxFromCenter) > Math.abs(dyFromCenter)) return dxFromCenter > 0 ? 'west' : 'east';
  return dyFromCenter > 0 ? 'north' : 'south';
}

function plural(n: number, noun: string): string {
  if (n === 1) return `one ${noun}`;
  if (n === 2) return `two ${noun}s`;
  if (n === 3) return `three ${noun}s`;
  if (n === 4) return `four ${noun}s`;
  return `${n} ${noun}s`;
}
