/**
 * mapTiles — themed GID constants shared by every per-terrain composer.
 *
 * All gids are scribble tileset LOCAL ids (firstgid=1; local id N = global gid
 * N for scribble) unless they appear under `WATER_GIDS`, which offsets by
 * `WATER_FIRSTGID` for the secondary water tileset.
 *
 * Rotation convention follows Tiled's flip-flag bits:
 *   • 0xA0000000  = 90° CW
 *   • 0xC0000000  = 180°
 *   • 0x60000000  = 270° CW
 *
 * Wall and path object gids are TRANSPARENT TWINS (cols 8–13 of the
 * spritesheet) so the underlying ground tile reads through.
 */

/** First GID of the water tileset, used as the offset for `WATER_GIDS`. */
export const WATER_FIRSTGID = 200;
const WL = WATER_FIRSTGID;

/** Ground-layer terrain tiles. Painted onto `terrainData`. */
export const TERRAIN_GIDS = {
  GRASS:               8,
  STONE_FLOOR:         15,
  STONE_FLOOR_CRACKED: 71,
  WOOD_FLOOR:          85,
} as const;

/** Object-layer wall pieces — the transparent-twin set used by the dungeon
 *  carver, the building stamper, and the tavern walls. */
export const WALL_GIDS = {
  NORTH:           11,
  SOUTH:           11 + 0xC0000000,
  EAST:            11 + 0xA0000000,
  WEST:            11 + 0x60000000,
  CORNER_TL:       10,
  CORNER_TR:       10 + 0xA0000000,
  CORNER_BR:       10 + 0xC0000000,
  CORNER_BL:       10 + 0x60000000,
  /** Concave (room wraps around the wall cell on two perpendicular sides).
   *  Naming follows the quadrant the WALL sits in (room is opposite). */
  PARTIAL_CORNER_UL: 66,
  PARTIAL_CORNER_UR: 66 + 0xA0000000,
  PARTIAL_CORNER_LR: 66 + 0xC0000000,
  PARTIAL_CORNER_LL: 66 + 0x60000000,
} as const;

/** Object-layer path tiles. `V` connects N+S, `H` connects E+W, corners
 *  connect the two cardinal directions in the name. `INTERSECTION` is the
 *  4-way crossing; T-junctions fall back to it. */
export const PATH_GIDS = {
  V:            23,
  H:            23 + 0xA0000000,
  CORNER_SE:    9,
  CORNER_SW:    9 + 0xA0000000,
  CORNER_NW:    9 + 0xC0000000,
  CORNER_NE:    9 + 0x60000000,
  INTERSECTION: 37,
} as const;

/** Furniture and doorway transparent twins used by interior composers
 *  (currently tavern, but reusable). */
export const FURNITURE_GIDS = {
  WOODEN_PLANK:   14,   // bar counter when laid in a row; standalone tables otherwise
  CHAIR:          28,
  BARRELS_THREE:  55,
  DOORWAY:        26,   // doorway_open_top_transparent (passable)
} as const;

/** Outdoor decoration overlays scattered by the biome-palette pass and the
 *  campsite placer. */
export const DECOR_GIDS = {
  TREE:         110,   // tree_transparent
  CAMPFIRE:     82,    // campfire_transparent
  FLOWERS:      96,    // flowers_transparent
  CRATE_CLOSED: 22,    // crate_closed — opaque (no transparent twin in the legend)
  BARRELS_TWO:  41,    // barrels_two_transparent
  FIREWOOD:     42,    // firewood_transparent
} as const;

/** Water tileset gids (local ids 0–15 offset by `WATER_FIRSTGID`). The
 *  coastline placer uses `WATER` for the fill and the matching
 *  `WATER_EDGE_<grass-side>` along the shoreline row. */
export const WATER_GIDS = {
  WATER:          WL + 0,
  EDGE_N:         WL + 4,
  EDGE_E:         WL + 5,
  EDGE_S:         WL + 6,
  EDGE_W:         WL + 7,
  OUTER_NW:       WL + 8,
  OUTER_NE:       WL + 9,
  OUTER_SE:       WL + 10,
  OUTER_SW:       WL + 11,
  INNER_NW:       WL + 12,
  INNER_NE:       WL + 13,
  INNER_SE:       WL + 14,
  INNER_SW:       WL + 15,
} as const;
