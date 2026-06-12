/**
 * MapComposer — deterministic map generator (the Adjudicator-layer
 * alternative to the AI map generator in `encounterGenerator.ts`).
 *
 * This file is a thin DISPATCHER: it parses `ComposeOptions`, builds the
 * shared RNG + zone-id allocator, and routes to a per-terrain composer
 * under `engine/maps/`. All terrain-specific logic — feature placers,
 * naming, rendering — lives in those modules:
 *
 *   • `maps/outdoor.ts` — grassland / forest + features
 *   • `maps/dungeon.ts` — 3- / 5-room dungeons
 *   • `maps/tavern.ts`  — single-room tavern
 *
 * Shared utilities (tileset refs, the mulberry32 PRNG, palette filter,
 * row-major flatten, zone-id allocator) live in `maps/shared.ts`.
 * GID constants are themed by purpose in `mapTiles.ts`.
 * Public types are in `mapTypes.ts`.
 */

import { composeOutdoor } from './maps/outdoor.js';
import { composeDungeon } from './maps/dungeon.js';
import { composeTavern  } from './maps/tavern.js';
import { composeCave    } from './maps/cave.js';
import { composeUrban   } from './maps/urban.js';
import { makeZoneIdAlloc, mulberry32 } from './maps/shared.js';
import type { ComposedMap, ComposeOptions } from './mapTypes.js';

// Re-export the types so existing call sites that import from
// `engine/MapComposer.js` keep working without rerouting.
export type { Terrain, Feature, StructureSpec, ComposeOptions, ComposedMap, MapAnchors, MapZone, ComposedTilesetRef, RegionSpec, ComposeRegionsOptions } from './mapTypes.js';
export { WATER_FIRSTGID } from './mapTiles.js';
// Multi-region big maps (US-126) — bands of biomes with ecotone blends and
// carved cave mouths. Separate entry point because its options differ.
export { composeRegions } from './maps/regions.js';

export function composeMap(opts: ComposeOptions): ComposedMap {
  const { width, height, terrain } = opts;
  if (width < 12 || height < 8) throw new Error('Map too small (min 12×8)');

  const seed = (opts.seed ?? Date.now()) & 0xffffffff;
  const rng = mulberry32(seed);
  const allocZoneId = makeZoneIdAlloc(seed);

  if (terrain === 'dungeon') {
    return composeDungeon({ width, height, features: opts.features, rng, allocZoneId });
  }
  if (terrain === 'tavern') {
    return composeTavern({ width, height, rng, allocZoneId });
  }
  if (terrain === 'cave') {
    return composeCave({ width, height, seed, large: opts.features.includes('5-room'), stairs: opts.features.includes('stairs') });
  }
  if (terrain === 'urban') {
    return composeUrban({ width, height, seed, buildingsCount: opts.buildingsCount });
  }
  return composeOutdoor({
    width, height,
    terrain,
    features: opts.features,
    structures: opts.structures,
    rng,
    allocZoneId,
  });
}
