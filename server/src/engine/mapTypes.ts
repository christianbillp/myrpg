/**
 * Public types for the deterministic map composer.
 *
 * Lives in its own file so per-terrain modules under `engine/maps/` can
 * import these without pulling in the `MapComposer.ts` dispatcher (which in
 * turn imports those modules).
 */

export type Terrain = 'grassland' | 'forest' | 'dungeon' | 'tavern' | 'cave' | 'urban';
export type Feature = 'campsites' | 'coastline' | 'path' | 'intersection' | '3-room' | '5-room' | 'stairs';

/** One configurable structure the user adds to an outdoor map. `rooms` (clamped
 *  1..5) are placed adjacent and linked by doorways through their shared walls;
 *  a ruin additionally cracks its floor and crumbles some wall segments. */
export interface StructureSpec {
  type: 'building' | 'ruin';
  rooms: number;
}

export interface ComposeOptions {
  width: number;
  height: number;
  terrain: Terrain;
  features: Feature[];
  /** Optional seed for the RNG. Same seed + same opts → same map. Defaults to Date.now(). */
  seed?: number;
  /** Outdoor structures (small buildings / ruins) to stamp, each individually
   *  configured. Replaces the old buildings/ruins feature counters. */
  structures?: StructureSpec[];
  /** Urban-only: how many buildings the town composer rings around its plaza
   *  (1..6, default 4). Not used by the outdoor structures path. */
  buildingsCount?: number;
}

export interface ComposedTilesetRef {
  firstgid: number;
  source: string;
}

/**
 * Named regions of interest a feature placer found / stamped. The randomizer
 * uses these to spawn the player and enemies at story-suitable locations
 * (entrance vs. vault, on a campfire vs. inland on a coastline) instead of
 * guessing geometrically. Every field is optional — only features the
 * composer actually placed end up populated.
 */
export interface MapAnchors {
  /** Campfire centres placed by `placeCampsites`. */
  campfires?: Array<{ x: number; y: number }>;
  /** Cells along the dry (grass) side, away from water. Populated when `coastline` is on. */
  inlandBand?: Array<{ x: number; y: number }>;
  /** Cells where a path emerges at the map edge — 2 for a straight path, 3
   *  for an intersection (or a T-junction on a coastline map). */
  pathEndpoints?: Array<{ x: number; y: number }>;
  /** The crossing cell, populated only when the `intersection` feature is on. */
  pathIntersection?: { x: number; y: number };
  /** Building footprints (full rectangle, stone-floor interior). */
  buildings?: Array<{ x: number; y: number; w: number; h: number }>;
  /** Dungeon rooms (rect + centre). Sorted by `cy + cx` so [0] is closest to
   *  NW and the last entry is deepest into the dungeon. */
  rooms?: Array<{ x: number; y: number; w: number; h: number; cx: number; cy: number }>;
  /** Centre cell of the southernmost dungeon room (or the cell south of the
   *  tavern doorway), where a visitor first enters. */
  entrance?: { x: number; y: number };
  /** Centre cell of the dungeon room farthest from the entrance. */
  vault?: { x: number; y: number };
}

/** Author-time named region. The save route persists these into the map
 *  JSON's `zones[]` verbatim. */
export interface MapZone {
  id: string;
  name: string;
  /** Display color (`#rrggbb`). */
  color: string;
  /** Cell coordinates as `"x,y"` strings. */
  cells: string[];
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
  /** Author-time named tile regions emitted by feature placers. Omitted when
   *  no feature emitted any (so the saved JSON stays byte-identical to maps
   *  composed before zones existed). */
  zones?: MapZone[];
}
