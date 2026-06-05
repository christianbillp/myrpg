/**
 * Material vocabulary — the model-facing names that map operations accept,
 * resolved here to concrete GIDs. The AI map generator works entirely in these
 * names ("cobbles", "cave_dust", "tree") and never sees a raw GID, so it can't
 * emit an invalid tile and the underlying tileset/firstgid scheme can change
 * without touching the prompt.
 *
 * Every constant draws from the themed GID groups in `mapTiles.ts`; this file
 * only re-keys them under designer-friendly names and groups them by role.
 */
import {
  TERRAIN_GIDS,
  WALL_GIDS,
  PATH_GIDS,
  FURNITURE_GIDS,
  DECOR_GIDS,
  WATER_GIDS,
  WATER_FIRSTGID,
  CAVE_URBAN_GIDS,
} from '../mapTiles.js';

/** Ground-layer floor materials a room/region can be paved with. */
export const GROUND_MATERIALS = {
  grass:         TERRAIN_GIDS.GRASS,
  stone_floor:   TERRAIN_GIDS.STONE_FLOOR,
  cracked_stone: TERRAIN_GIDS.STONE_FLOOR_CRACKED,
  wood_floor:    TERRAIN_GIDS.WOOD_FLOOR,
  cave_dust:     CAVE_URBAN_GIDS.CAVE_DUST,
  cave_gravel:   CAVE_URBAN_GIDS.CAVE_GRAVEL,
  cave_rock:     CAVE_URBAN_GIDS.CAVE_ROCKY,
  cave_smooth:   CAVE_URBAN_GIDS.CAVE_SMOOTH,
  cobbles:       CAVE_URBAN_GIDS.URBAN_COBBLES,
  bricks:        CAVE_URBAN_GIDS.URBAN_BRICKS,
  slabs:         CAVE_URBAN_GIDS.URBAN_LARGE_SLABS,
  plaza:         CAVE_URBAN_GIDS.URBAN_PLAIN,
} as const;
export type GroundMaterial = keyof typeof GROUND_MATERIALS;

/** Object-layer decoration the scatter/feature ops can drop on passable ground. */
export const DECOR_MATERIALS = {
  tree:     DECOR_GIDS.TREE,
  flowers:  DECOR_GIDS.FLOWERS,
  campfire: DECOR_GIDS.CAMPFIRE,
  firewood: DECOR_GIDS.FIREWOOD,
  crate:    DECOR_GIDS.CRATE_CLOSED,
  barrels:  DECOR_GIDS.BARRELS_TWO,
} as const;
export type DecorMaterial = keyof typeof DECOR_MATERIALS;

/** Furniture object tiles (tavern / interior dressing). */
export const FURNITURE_MATERIALS = {
  table:        FURNITURE_GIDS.WOODEN_PLANK,
  chair:        FURNITURE_GIDS.CHAIR,
  barrels_tall: FURNITURE_GIDS.BARRELS_THREE,
  doorway:      FURNITURE_GIDS.DOORWAY,
  stairs:       FURNITURE_GIDS.STAIRS_UP,
} as const;
export type FurnitureMaterial = keyof typeof FURNITURE_MATERIALS;

/**
 * Hazard ground tiles — impassable terrain that doubles as a tactical feature.
 * Pools block movement but not sight; chasms block both (a real obstacle that
 * also breaks line of sight). All live on the ground layer.
 */
export const HAZARD_MATERIALS = {
  pool:         CAVE_URBAN_GIDS.CAVE_POOL,
  chasm_small:  CAVE_URBAN_GIDS.CHASM_SMALL,
  chasm:        CAVE_URBAN_GIDS.CHASM_MEDIUM,
  chasm_large:  CAVE_URBAN_GIDS.CHASM_LARGE,
} as const;
export type HazardMaterial = keyof typeof HAZARD_MATERIALS;

/** Everything paintable as a single ground GID, for the low-level paint op. */
export const GROUND_PAINTABLE = { ...GROUND_MATERIALS, ...HAZARD_MATERIALS } as const;
export type GroundPaintable = keyof typeof GROUND_PAINTABLE;

/** Everything paintable as a single object GID, for the low-level paint op. */
export const OBJECT_PAINTABLE = { ...DECOR_MATERIALS, ...FURNITURE_MATERIALS } as const;
export type ObjectPaintable = keyof typeof OBJECT_PAINTABLE;

/**
 * The rectangular wall-ring tile set (corners + cardinal edges) used by
 * `stampRoom`. Same transparent-twin scribble tiles buildings and the tavern
 * already use, so a stamped room reads identically to a composed one.
 */
export const WALL_RING = {
  CORNER_TL: WALL_GIDS.CORNER_TL,
  CORNER_TR: WALL_GIDS.CORNER_TR,
  CORNER_BL: WALL_GIDS.CORNER_BL,
  CORNER_BR: WALL_GIDS.CORNER_BR,
  NORTH:     WALL_GIDS.NORTH,
  SOUTH:     WALL_GIDS.SOUTH,
  EAST:      WALL_GIDS.EAST,
  WEST:      WALL_GIDS.WEST,
} as const;

/** The full wall GID set (ring + concave partial corners) for wall-following
 *  around arbitrary floor shapes (caves, organic rooms). */
export { WALL_GIDS, PATH_GIDS, WATER_GIDS };

/** Resolve a ground material name to its GID, or undefined if unknown. */
export function groundGid(name: string): number | undefined {
  return (GROUND_PAINTABLE as Record<string, number>)[name];
}

/** Resolve an object material name to its GID, or undefined if unknown. */
export function objectGid(name: string): number | undefined {
  return (OBJECT_PAINTABLE as Record<string, number>)[name];
}

/**
 * Conservative movement-blocking test for any GID the op vocabulary can place.
 * Used by `validateCanvas` for connectivity flood-fill without loading the full
 * tileset legends. Mirrors the legend defaults: walls, all water tiles, and the
 * cave hazards (pools + chasms) block; floors, paths, doorways, and most decor
 * pass; bulky decor (trees, crates, barrels) blocks.
 *
 * The object layer overrides the ground layer for movement (a doorway over a
 * wall opens the cell), matching `SessionBuilder`'s rule — so callers pass the
 * effective GID (object if non-zero, else ground).
 */
const BLOCKING_OBJECT_GIDS = new Set<number>([
  WALL_GIDS.NORTH, WALL_GIDS.SOUTH, WALL_GIDS.EAST, WALL_GIDS.WEST,
  WALL_GIDS.CORNER_TL, WALL_GIDS.CORNER_TR, WALL_GIDS.CORNER_BL, WALL_GIDS.CORNER_BR,
  WALL_GIDS.PARTIAL_CORNER_UL, WALL_GIDS.PARTIAL_CORNER_UR,
  WALL_GIDS.PARTIAL_CORNER_LL, WALL_GIDS.PARTIAL_CORNER_LR,
  DECOR_GIDS.TREE, DECOR_GIDS.CRATE_CLOSED, DECOR_GIDS.BARRELS_TWO, FURNITURE_GIDS.BARRELS_THREE,
].map((g) => g & 0x1fffffff));

export function objectBlocksMovement(rawGid: number): boolean {
  if (rawGid === 0) return false;
  return BLOCKING_OBJECT_GIDS.has(rawGid & 0x1fffffff);
}

export function groundBlocksMovement(rawGid: number): boolean {
  const gid = rawGid & 0x1fffffff;
  if (gid === 0) return true; // void — no floor to stand on
  if (gid >= WATER_FIRSTGID && gid < WATER_FIRSTGID + 16) return true; // any water tile
  if (gid === HAZARD_MATERIALS.pool || gid === HAZARD_MATERIALS.chasm_small
    || gid === HAZARD_MATERIALS.chasm || gid === HAZARD_MATERIALS.chasm_large) return true;
  return false;
}

/** Human-readable list of valid names for a role, for tool enums + errors. */
export const MATERIAL_NAMES = {
  ground:    Object.keys(GROUND_MATERIALS),
  hazard:    Object.keys(HAZARD_MATERIALS),
  decor:     Object.keys(DECOR_MATERIALS),
  furniture: Object.keys(FURNITURE_MATERIALS),
} as const;
