/**
 * BiomePalettes — per-biome ground+object GID pools used by the deterministic
 * MapComposer and (via prompt grounding) the AI encounter generator.
 *
 * The multilayer rendering model: every cell gets a ground GID (drawn first)
 * and an optional object GID drawn on top. Ground tiles supply the floor
 * texture; object tiles (transparent-twin GIDs from the scribble tileset)
 * decorate or block cells without painting over the floor underneath.
 *
 * Variation is produced by mixing palette entries instead of authoring new
 * combination tiles — e.g. a "grassland" floor is mostly `grass` with a
 * sprinkle of `terrain_bumpy` and `stone_floor_cracked`, with `flowers` and
 * `tree` transparent twins layered on top per their per-entry density.
 */

export interface GroundEntry {
  /** Tile GID from the scribble tileset. Must be a `layer: "ground"` tile. */
  gid: number;
  /** Relative weight for weighted random selection. Sum of weights need not equal 1. */
  weight: number;
}

export type ObjectClustering = 'spread' | 'clump' | 'wall_adjacent';

export interface ObjectEntry {
  /** Tile GID from the scribble tileset. Must be a `layer: "object"` transparent-twin tile. */
  gid: number;
  /** Per-cell probability (0..1) the cell gets this object overlay. */
  density: number;
  /** Placement rule:
   *  - `spread`: reject if a same-GID neighbour is within `spreadRadius`.
   *  - `clump`: boost probability if a same-GID neighbour exists nearby.
   *  - `wall_adjacent`: only roll if at least one orthogonal neighbour is impassable.
   */
  clustering: ObjectClustering;
  /** Min cell-distance from same-GID neighbours for `spread`. Default 2. */
  spreadRadius?: number;
  /** Probability multiplier per existing same-GID neighbour for `clump`. Default 2.5. */
  clumpFactor?: number;
}

export type BiomeId = 'grassland' | 'forest' | 'dungeon' | 'cave' | 'urban';

export interface BiomePalette {
  id: BiomeId;
  groundPool: GroundEntry[];
  objectPool: ObjectEntry[];
}

const GRASS = 8;
const TERRAIN_BUMPY = 99;
const STONE_FLOOR = 15;
const STONE_FLOOR_DIAMOND = 43;
const STONE_FLOOR_INLAY = 57;
const STONE_FLOOR_CRACKED = 71;

const FLOWERS_TRANSPARENT = 96;
const TREE_TRANSPARENT = 110;

// Cave + urban floors live in the cave_and_urban_floors tileset (firstgid 300).
// These are GLOBAL gids (firstgid already applied); the canvas derives the
// tileset from the gids used, so a cave/urban fill auto-declares that tileset.
const CAVE_DUST = 300;
const CAVE_ROCKY = 302;
const CAVE_GRAVEL = 303;
const URBAN_COBBLES = 307;
const URBAN_BRICKS = 308;
const URBAN_SLABS = 315;

export const BIOME_PALETTES: Record<BiomeId, BiomePalette> = {
  grassland: {
    id: 'grassland',
    groundPool: [
      { gid: GRASS,         weight: 90 },
      { gid: TERRAIN_BUMPY, weight: 10 },
    ],
    objectPool: [
      { gid: FLOWERS_TRANSPARENT, density: 0.05, clustering: 'spread', spreadRadius: 2 },
      { gid: TREE_TRANSPARENT,    density: 0.02, clustering: 'clump',  clumpFactor: 3 },
    ],
  },
  forest: {
    id: 'forest',
    groundPool: [
      { gid: GRASS,         weight: 85 },
      { gid: TERRAIN_BUMPY, weight: 15 },
    ],
    objectPool: [
      { gid: TREE_TRANSPARENT,    density: 0.09, clustering: 'clump',  clumpFactor: 2.5 },
      { gid: FLOWERS_TRANSPARENT, density: 0.06, clustering: 'spread', spreadRadius: 2 },
    ],
  },
  dungeon: {
    id: 'dungeon',
    // Stone floors with rare accents (cracked / diamond / inlay) for visual
    // variation cell-to-cell. The composer's dungeon carver samples from this
    // pool to texture every floor tile inside a room or corridor.
    groundPool: [
      { gid: STONE_FLOOR,         weight: 75 },
      { gid: STONE_FLOOR_CRACKED, weight: 15 },
      { gid: STONE_FLOOR_DIAMOND, weight: 7  },
      { gid: STONE_FLOOR_INLAY,   weight: 3  },
    ],
    // Decoration objects are placed by feature placers (campfires, furniture,
    // etc.) — not by the per-cell decoration pass, which would clutter
    // corridors.
    objectPool: [],
  },
  cave: {
    id: 'cave',
    // Varied cavern floor — mostly dust with gravel + rocky patches so a
    // hand-carved cave reads as natural rock rather than a flat fill.
    groundPool: [
      { gid: CAVE_DUST,   weight: 60 },
      { gid: CAVE_GRAVEL, weight: 25 },
      { gid: CAVE_ROCKY,  weight: 15 },
    ],
    // Cave decoration (pools, chasms) is placed deliberately as hazards, not
    // scattered per-cell.
    objectPool: [],
  },
  urban: {
    id: 'urban',
    // Varied paving — cobbles dominant with brick + slab patches for streets,
    // courtyards, and plazas.
    groundPool: [
      { gid: URBAN_COBBLES, weight: 55 },
      { gid: URBAN_BRICKS,  weight: 25 },
      { gid: URBAN_SLABS,   weight: 20 },
    ],
    objectPool: [],
  },
};

/** Pick a ground GID using the palette's weighted distribution. */
export function pickGroundGid(palette: BiomePalette, rng: () => number): number {
  const total = palette.groundPool.reduce((s, e) => s + e.weight, 0);
  let roll = rng() * total;
  for (const e of palette.groundPool) {
    roll -= e.weight;
    if (roll <= 0) return e.gid;
  }
  return palette.groundPool[palette.groundPool.length - 1].gid;
}

/**
 * Roll the palette's object pool against a single cell. Returns the chosen
 * object GID, or 0 if nothing was placed. Honors per-entry clustering: a
 * `spread` entry rejects if a same-GID neighbour is within `spreadRadius`;
 * a `clump` entry has its density multiplied per adjacent same-GID cell.
 *
 * `existingObj` is the row-major object grid built so far (cells beyond the
 * current scan are still 0 — clumping is therefore biased toward the NW
 * neighbours, which is deliberate and produces natural-looking patches).
 * `isWall(x,y)` returns true iff the ground cell is impassable.
 */
export function rollObjectGid(
  palette: BiomePalette,
  rng: () => number,
  x: number,
  y: number,
  width: number,
  height: number,
  existingObj: number[],
  isWall: (x: number, y: number) => boolean,
  /** Optional per-cell density multiplier (Roadmap v2 · M3/#6 density curves) —
   *  e.g. an edge→interior ramp that clears a forest's centre. Default 1. */
  densityScale?: (x: number, y: number) => number,
): number {
  const scale = densityScale ? densityScale(x, y) : 1;
  for (const entry of palette.objectPool) {
    const density = entry.density * scale;
    const radius = entry.spreadRadius ?? 2;
    if (entry.clustering === 'spread') {
      let crowded = false;
      for (let dy = -radius; dy <= radius && !crowded; dy++) {
        for (let dx = -radius; dx <= radius && !crowded; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (existingObj[ny * width + nx] === entry.gid) crowded = true;
        }
      }
      if (crowded) continue;
      if (rng() < density) return entry.gid;
      continue;
    }
    if (entry.clustering === 'clump') {
      let sameNeighbours = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (existingObj[ny * width + nx] === entry.gid) sameNeighbours++;
        }
      }
      const factor = entry.clumpFactor ?? 2.5;
      const p = Math.min(0.95, density * (1 + sameNeighbours * (factor - 1)));
      if (rng() < p) return entry.gid;
      continue;
    }
    if (entry.clustering === 'wall_adjacent') {
      const orthoWall = isWall(x - 1, y) || isWall(x + 1, y) || isWall(x, y - 1) || isWall(x, y + 1);
      if (!orthoWall) continue;
      if (rng() < density) return entry.gid;
      continue;
    }
  }
  return 0;
}

/** An edge→interior density ramp for the `clearing` feature: ~0 inside a central
 *  glade radius, rising toward the map edge — so a forest reads as a ringed
 *  treeline around open ground. */
export function edgeRampDensity(width: number, height: number): (x: number, y: number) => number {
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  return (x, y) => {
    const d = Math.hypot(x - cx, y - cy) / maxD; // 0 centre … 1 corner
    const t = Math.max(0, (d - 0.35) / 0.65);    // clear within 35% radius
    return Math.min(3, t * t * 3);
  };
}
