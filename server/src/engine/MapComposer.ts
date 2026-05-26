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
 * level features (ruins, buildings, campsites) are layered on top of a base
 * terrain (grassland or forest).
 *
 * GIDs here are hard-coded to the scribble tileset since that's the only
 * tileset currently in use. If we ever support a second tileset, this would
 * lift to a per-tileset palette table.
 */

// ── Scribble palette ────────────────────────────────────────────────────────

const G = {
  GRASS: 8,
  STONE_FLOOR: 15,
  STONE_FLOOR_CRACKED: 71,
  WALL_NORTH: 4,
  WALL_SOUTH: 4 + 0xC0000000,           // 180°
  WALL_EAST:  4 + 0xA0000000,           // 90° CW
  WALL_WEST:  4 + 0x60000000,           // 270° CW
  CORNER_TL:  3,
  CORNER_TR:  3 + 0xA0000000,
  CORNER_BR:  3 + 0xC0000000,
  CORNER_BL:  3 + 0x60000000,
  TREE: 103,
  CAMPFIRE: 75,
  FLOWERS: 89,
  CRATE_CLOSED: 22,
  BARRELS_TWO: 34,
  FIREWOOD: 35,
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
};

export type Terrain = 'grassland' | 'forest';
export type Feature = 'ruins' | 'buildings' | 'campsites' | 'path';

export interface ComposeOptions {
  width: number;
  height: number;
  terrain: Terrain;
  features: Feature[];
  /** Optional seed for the RNG. Same seed + same opts → same map. Defaults to Date.now(). */
  seed?: number;
}

export interface ComposedMap {
  width: number;
  height: number;
  terrainData: number[];
  objectData: number[];
  name: string;
  description: string;
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

export function composeMap(opts: ComposeOptions): ComposedMap {
  const { width, height, terrain, features } = opts;
  if (width < 12 || height < 8) throw new Error('Map too small (min 12×8)');

  const rng = mulberry32((opts.seed ?? Date.now()) & 0xffffffff);

  // Grid init — grass everywhere by default; object layer empty.
  const terrainGrid: number[][] = [];
  const objectGrid: number[][] = [];
  for (let r = 0; r < height; r++) {
    terrainGrid.push(new Array<number>(width).fill(G.GRASS));
    objectGrid.push(new Array<number>(width).fill(0));
  }

  // Terrain layer modifications.
  if (terrain === 'forest') {
    // Scatter trees densely with clumping — Poisson-ish with a thinner belt
    // along the south edge so the player has open ground to spawn on.
    for (let r = 0; r < height; r++) {
      const density = r < height - 3 ? 0.22 : 0.05;
      for (let c = 0; c < width; c++) {
        if (rng() < density) objectGrid[r][c] = G.TREE;
      }
    }
  }

  // Features layer.
  // Path is laid down first so ruins/buildings/campsites stamp over it where they overlap
  // — i.e. the path runs through the map and other features sit on top of (or replace) it.
  if (features.includes('path'))       placePath(terrainGrid, objectGrid, rng, width, height);
  if (features.includes('ruins'))      placeRuins(terrainGrid, objectGrid, rng, width, height);
  if (features.includes('buildings'))  placeBuildings(terrainGrid, objectGrid, rng, width, height);
  if (features.includes('campsites'))  placeCampsites(terrainGrid, objectGrid, rng, width, height);

  return {
    width, height,
    terrainData: flatten(terrainGrid),
    objectData: flatten(objectGrid),
    name: composeName(terrain, features),
    description: composeDescription(terrain, features),
  };
}

// ── Feature placers ─────────────────────────────────────────────────────────

function placeRuins(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number): void {
  const count = 2 + Math.floor(rng() * 2);  // 2-3 ruined buildings
  for (let i = 0; i < count; i++) {
    const w = 6 + Math.floor(rng() * 4);   // 6-9 wide
    const h = 5 + Math.floor(rng() * 3);   // 5-7 tall
    const x = 1 + Math.floor(rng() * Math.max(1, W - w - 2));
    const y = 1 + Math.floor(rng() * Math.max(1, H - h - 2));
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
    } catch { /* skip if room overlaps edge */ }
  }
}

function placeBuildings(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number): void {
  const count = 1 + Math.floor(rng() * 2);  // 1-2 intact buildings
  for (let i = 0; i < count; i++) {
    const w = 6 + Math.floor(rng() * 3);
    const h = 5 + Math.floor(rng() * 3);
    const x = 1 + Math.floor(rng() * Math.max(1, W - w - 2));
    const y = 1 + Math.floor(rng() * Math.max(1, H - h - 2));
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
    } catch { /* skip if room overlaps edge */ }
  }
}

function placePath(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number): void {
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

  for (const cell of cells) {
    if (cell.x < 0 || cell.x >= W || cell.y < 0 || cell.y >= H) continue;
    terrain[cell.y][cell.x] = cell.tile;
    if (objects[cell.y][cell.x] === G.TREE) objects[cell.y][cell.x] = 0;
  }
}

function placeCampsites(terrain: number[][], objects: number[][], rng: () => number, W: number, H: number): void {
  const count = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < count; i++) {
    const cx = 2 + Math.floor(rng() * (W - 4));
    const cy = 2 + Math.floor(rng() * (H - 4));
    // Campfire in the centre.
    objects[cy][cx] = G.CAMPFIRE;
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

// ── Naming + helpers ────────────────────────────────────────────────────────

function composeName(terrain: Terrain, features: Feature[]): string {
  const t = terrain === 'forest' ? 'Forest' : 'Field';
  if (features.length === 0) return t;
  const f = features[0];
  const adj = f === 'ruins' ? 'Ruined' : f === 'buildings' ? 'Settled' : 'Camped';
  return `${adj} ${t}`;
}

function composeDescription(terrain: Terrain, features: Feature[]): string {
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
