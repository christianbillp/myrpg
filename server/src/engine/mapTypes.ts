/**
 * Public types for the deterministic map composer.
 *
 * Lives in its own file so per-terrain modules under `engine/maps/` can
 * import these without pulling in the `MapComposer.ts` dispatcher (which in
 * turn imports those modules).
 */

/** Canonical terrain list — the single runtime source of truth. `composeMap`'s
 *  dispatch registry, the route validator, and any client/server enum derive
 *  from this so adding a terrain is ONE edit, not four. */
export const TERRAINS = ['grassland', 'forest', 'dungeon', 'cave', 'urban'] as const;
export type Terrain = typeof TERRAINS[number];
export type Feature = 'campsites' | 'coastline' | 'path' | 'intersection' | '3-room' | '5-room' | 'stairs';

/** One configurable structure the user adds to an outdoor map. `rooms` (clamped
 *  1..5) are placed adjacent and linked by doorways through their shared walls;
 *  a ruin additionally cracks its floor and crumbles some wall segments. */
export interface StructureSpec {
  type: 'building' | 'ruin';
  rooms: number;
  /** Big-map only (Phase B): index of the region the structure must be placed in
   *  (into the encounter's `regions[]`). Omitted = anywhere open. */
  region?: number;
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
  /** Ambient light inside this zone (US-126). When set, the session bake
   *  writes it into `GameMap.light` for every cell, overriding the
   *  encounter-wide `environment.lightLevel` — how a cave region stays dark
   *  on a map whose grassland is bright. Omitted = no override. */
  lightLevel?: 'bright' | 'dim' | 'dark';
}

/** One region of a multi-biome map (US-126) — see `composeRegions`. */
export interface RegionSpec {
  /** Biome of this band. Open biomes (grassland/forest/urban) fill their
   *  band with palette ground; enclosed biomes (cave/dungeon) start as solid
   *  rock and get an interior carved, entered through a carved mouth. */
  terrain: 'grassland' | 'forest' | 'urban' | 'cave' | 'dungeon';
  /** Relative share of the map's long axis (default 1). */
  share?: number;
  /** Zone display name (defaults to the biome name). */
  name?: string;
  /** Ambient light for the region's zone. Defaults: `dark` for cave/dungeon,
   *  no override (encounter-wide light) for open biomes. */
  light?: 'bright' | 'dim' | 'dark';
}

export interface ComposeRegionsOptions {
  width: number;
  height: number;
  /** 2–5 regions, laid out as bands along the map's long axis in order. */
  regions: RegionSpec[];
  /** Same seed + same options → byte-identical map. */
  seed?: number;
}

/** A placeable structure that was stamped onto a composed map (Phase B). Records
 *  where it landed and its interior seed, so a single one can be re-rolled in
 *  place (`restampPlaceable`) without recomposing the whole map. */
export interface PlacementRecord {
  /** Registry id of the placeable (`watchtower`, `building`, `tavern`, …). */
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Requested room count for parametric placeables (building/ruin). */
  rooms?: number;
  /** Seed driving this placeable's interior layout — re-roll it to regenerate
   *  just this structure's interior. */
  interiorSeed: number;
}

/** Tactical read of a map's fighting shape (Roadmap v2 · G1). Computed by
 *  `tacticalAnalysis` in `maps/tactical.ts`; attached to a composed map so the
 *  encounter layer can place spawns by role and the composer can reject
 *  degenerate layouts. */
export interface TacticalMetrics {
  openCells: number;
  coverRatio: number;
  openness: number;
  chokepoints: Array<{ x: number; y: number }>;
  holdZones: Array<{ cx: number; cy: number; size: number; entrances: number }>;
  loops: number;
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
  /** Placeable structures stamped onto this map (Phase B), for in-place re-roll.
   *  Omitted when none were placed. */
  placements?: PlacementRecord[];
  /** Author-time named tile regions emitted by feature placers. Omitted when
   *  no feature emitted any (so the saved JSON stays byte-identical to maps
   *  composed before zones existed). */
  zones?: MapZone[];
  /** Tactical read of the map's fighting shape (Roadmap v2 · G1). Additive —
   *  omitted unless a compose path requested it. */
  tactical?: TacticalMetrics;
}
