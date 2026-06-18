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
 *   • `maps/cave.ts` · `maps/urban.ts` — caverns / town
 *
 * Shared utilities (tileset refs, the mulberry32 PRNG, palette filter,
 * row-major flatten, zone-id allocator) live in `maps/shared.ts`.
 * GID constants are themed by purpose in `mapTiles.ts`.
 * Public types are in `mapTypes.ts`.
 */

import { composeOutdoor } from './maps/outdoor.js';
import { composeDungeon } from './maps/dungeon.js';
import { composeCave    } from './maps/cave.js';
import { composeUrban   } from './maps/urban.js';
import { makeZoneIdAlloc, mulberry32 } from './maps/shared.js';
import { stampExtrasOnto, applyBigMapRoads, type StampSpec } from './maps/mapFeatures.js';
import { composeRegions as composeRegionsImpl } from './maps/regions.js';
import { tacticalAnalysisOfMap } from './maps/tactical.js';
import { TERRAINS } from './mapTypes.js';
import type { ComposedMap, ComposeOptions, Terrain, Feature, StructureSpec, RegionSpec, TacticalMetrics } from './mapTypes.js';

// Re-export the types so existing call sites that import from
// `engine/MapComposer.js` keep working without rerouting.
export type { Terrain, Feature, StructureSpec, ComposeOptions, ComposedMap, MapAnchors, MapZone, ComposedTilesetRef, RegionSpec, ComposeRegionsOptions } from './mapTypes.js';
export { TERRAINS } from './mapTypes.js';
export { WATER_FIRSTGID } from './mapTiles.js';
// Feature recipe layer (Phase A) — named set-pieces stamped from the op toolbox,
// plus the standalone "show me this set-piece" composer behind the editor chips.
export { composeFeatureMap, stampFeatureOnto, stampExtrasOnto, restampPlaceable, FEATURE_REGISTRY, FEATURE_IDS, placeFeature, type StampSpec, type PlaceableParams } from './maps/mapFeatures.js';
// Tactical analysis (Roadmap v2 · G1) — fighting-shape metrics off the passable grid.
export { tacticalAnalysis, tacticalAnalysisOfMap } from './maps/tactical.js';
export type { TacticalMetrics } from './mapTypes.js';
// `composeTerrainWithFeature` / `composeRegionsWithExtras` (extras stamped onto a
// re-rolled-until-clean base) are defined below in this file.
// Multi-region big maps (US-126) — bands of biomes with ecotone blends and
// carved cave mouths. Separate entry point because its options differ.
export { composeRegionsImpl as composeRegions };

/**
 * Normalised inputs every per-terrain composer can draw from. `composeMap`
 * builds this once (parsing `ComposeOptions`, seeding the shared RNG + zone-id
 * allocator) and hands it to the registered composer; each adapter forwards
 * just the fields its composer needs. New terrains plug in by adding one
 * registry entry — no dispatch `if`-chain to extend.
 */
interface ComposerContext {
  width: number;
  height: number;
  features: Feature[];
  structures?: StructureSpec[];
  buildingsCount?: number;
  seed: number;
  rng: () => number;
  allocZoneId: (kind: string) => string;
}
type Composer = (terrain: Terrain, ctx: ComposerContext) => ComposedMap;

/**
 * Terrain → composer dispatch table. Keyed by the canonical `Terrain` union, so
 * TypeScript enforces that every terrain has a composer (and every composer a
 * terrain). The shared outdoor composer backs both open biomes.
 */
const TERRAIN_COMPOSERS: Record<Terrain, Composer> = {
  dungeon: (_t, ctx) => composeDungeon({ width: ctx.width, height: ctx.height, features: ctx.features, rng: ctx.rng, allocZoneId: ctx.allocZoneId }),
  cave:    (_t, ctx) => composeCave({ width: ctx.width, height: ctx.height, seed: ctx.seed, large: ctx.features.includes('5-room'), stairs: ctx.features.includes('stairs') }),
  urban:   (_t, ctx) => composeUrban({ width: ctx.width, height: ctx.height, seed: ctx.seed, buildingsCount: ctx.buildingsCount }),
  grassland: (t, ctx) => composeOutdoor({ width: ctx.width, height: ctx.height, terrain: t as 'grassland' | 'forest', features: ctx.features, structures: ctx.structures, rng: ctx.rng, allocZoneId: ctx.allocZoneId }),
  forest:    (t, ctx) => composeOutdoor({ width: ctx.width, height: ctx.height, terrain: t as 'grassland' | 'forest', features: ctx.features, structures: ctx.structures, rng: ctx.rng, allocZoneId: ctx.allocZoneId }),
};

/** All terrain names `composeMap` accepts — derived from the registry so it can
 *  never drift from what's actually dispatchable. */
export const COMPOSABLE_TERRAINS: readonly Terrain[] = TERRAINS;

export function composeMap(opts: ComposeOptions): ComposedMap {
  const { width, height, terrain } = opts;
  if (width < 12 || height < 8) throw new Error('Map too small (min 12×8)');

  const composer = TERRAIN_COMPOSERS[terrain];
  if (!composer) throw new Error(`Unknown terrain "${terrain}"`);

  // RNG + zone-id allocator are seeded BEFORE dispatch (as the old if-chain did)
  // so the stream each composer consumes is byte-identical to the pre-registry
  // behaviour — the seed-stability snapshot guards this.
  const seed = (opts.seed ?? Date.now()) & 0xffffffff;
  const rng = mulberry32(seed);
  const allocZoneId = makeZoneIdAlloc(seed);

  return composer(terrain, {
    width, height,
    features: opts.features,
    structures: opts.structures,
    buildingsCount: opts.buildingsCount,
    seed, rng, allocZoneId,
  });
}

/**
 * Stamp a list of EXTRAS (set-pieces and/or buildings/ruins) onto a base map and
 * RE-ROLL until they all fit cleanly (Phase A5).
 *
 * Conscious placement (`findFeaturePlacement`) avoids the base's trees, roads,
 * and water, but a busy base can force a stamp to overwrite something. So this
 * calls `makeBase(seed)` with a fresh seed each try until the summed placement
 * score is 0 — a clean fit with nothing overwritten — so the user only ever sees
 * a valid map. If no try is perfectly clean within `maxTries`, the
 * least-disruptive wins. Works for ANY base (single terrain or a big map).
 */
function composeWithExtrasRetry(makeBase: (seed: number) => ComposedMap, stamps: StampSpec[], baseSeed: number, maxTries: number, tactical = false): ComposedMap {
  const finalize = (map: ComposedMap, metrics: TacticalMetrics | null): ComposedMap => (metrics ? { ...map, tactical: metrics } : map);
  if (stamps.length === 0) {
    const base = makeBase(baseSeed);
    return finalize(base, tactical ? tacticalAnalysisOfMap(base) : null);
  }
  const tries = Math.max(1, maxTries);
  let best: { map: ComposedMap; metrics: TacticalMetrics | null; rank: number } | null = null;
  for (let i = 0; i < tries; i++) {
    const seed = (baseSeed + i) & 0xffffffff;
    const { map, score } = stampExtrasOnto(makeBase(seed), stamps, seed);
    const metrics = tactical ? tacticalAnalysisOfMap(map) : null;
    const degenerate = metrics ? isDegenerateLayout(metrics) : false;
    // A clean fit (nothing overwritten) that isn't tactically degenerate wins now.
    if (score === 0 && !degenerate) return finalize(map, metrics);
    // Otherwise rank: penalise degenerate layouts heavily, then prefer a cleaner fit.
    const rank = (degenerate ? 1_000_000 : 0) + score;
    if (!best || rank < best.rank) best = { map, metrics, rank };
  }
  return finalize(best!.map, best!.metrics);
}

/** A layout offers nothing for a fight to use: essentially no cover AND not a
 *  single chokepoint to hold. (Skipped on tiny maps — too small to judge.) */
export function isDegenerateLayout(m: TacticalMetrics): boolean {
  if (m.openCells < 24) return false;
  return m.coverRatio < 0.05 && m.chokepoints.length === 0;
}

/** One placeable as the route/editor send it — any registry id, with an optional
 *  room count (building/ruin) and target region (big map). */
export interface PlaceableInput { id: string; rooms?: number; region?: number; }

/** Build the unified placeable stamp list. `placeables` (the merged
 *  structures+set-pieces list) is the canonical channel; `structures` + `feature`
 *  remain for back-compat. */
function buildStamps(structures?: StructureSpec[], feature?: string, placeables?: PlaceableInput[]): StampSpec[] {
  const stamps: StampSpec[] = (structures ?? []).map((spec) => ({ id: spec.type, params: { rooms: spec.rooms }, region: spec.region }));
  for (const p of placeables ?? []) stamps.push({ id: p.id, params: p.rooms !== undefined ? { rooms: p.rooms } : undefined, region: p.region });
  if (feature) stamps.push({ id: feature });
  return stamps;
}

/** Compose an OPEN terrain (grassland/forest/urban) with a set-piece stamped
 *  onto a re-rolled-until-clean base. (Outdoor `structures` are baked by the base
 *  composer, so only the set-piece is stamped here.) */
export function composeTerrainWithFeature(opts: {
  width: number;
  height: number;
  terrain: Terrain;
  feature?: string;
  features?: Feature[];
  structures?: StructureSpec[];
  placeables?: PlaceableInput[];
  seed?: number;
  maxTries?: number;
  /** Attach `tactical` metrics and prefer a non-degenerate layout (Roadmap v2 · M1). */
  tactical?: boolean;
}): ComposedMap {
  return composeWithExtrasRetry(
    (seed) => composeMap({ width: opts.width, height: opts.height, terrain: opts.terrain, features: opts.features ?? [], structures: opts.structures, seed }),
    buildStamps(undefined, opts.feature, opts.placeables), (opts.seed ?? Date.now()) & 0xffffffff, opts.maxTries ?? 10, opts.tactical ?? false,
  );
}

/**
 * Compose a multi-region BIG MAP with EXTRAS — buildings/ruins AND/OR a set-piece
 * — stamped onto a re-rolled-until-clean base, so every map-creation function
 * (not just terrains) is available on big maps. Structures and set-pieces land in
 * open bands; conscious placement keeps them off the rock of enclosed
 * (cave/dungeon) regions. With no extras it's a plain big map.
 */
export function composeRegionsWithExtras(opts: {
  width: number;
  height: number;
  regions: RegionSpec[];
  structures?: StructureSpec[];
  feature?: string;
  placeables?: PlaceableInput[];
  /** `path` / `intersection` roads laid across the open bands (other outdoor
   *  features are per-region terrain fill and don't apply post-hoc). */
  features?: Feature[];
  seed?: number;
  maxTries?: number;
  /** Attach `tactical` metrics and prefer a non-degenerate layout (Roadmap v2 · M1). */
  tactical?: boolean;
}): ComposedMap {
  return composeWithExtrasRetry(
    (seed) => {
      const base = composeRegionsImpl({ width: opts.width, height: opts.height, regions: opts.regions, seed });
      return applyBigMapRoads(base, opts.features ?? [], enclosedRegionCells(base, opts.regions));
    },
    buildStamps(opts.structures, opts.feature, opts.placeables), (opts.seed ?? Date.now()) & 0xffffffff, opts.maxTries ?? 10, opts.tactical ?? false,
  );
}

/** Cells belonging to cave/dungeon regions — roads must not enter these. The
 *  regions composer emits one zone per region, in region order, so the i-th
 *  region zone's cells are region `i`'s floor. */
function enclosedRegionCells(base: ComposedMap, regions: RegionSpec[]): Set<string> {
  const cells = new Set<string>();
  const regionZones = (base.zones ?? []).filter((z) => z.id.includes('_region_'));
  regions.forEach((r, i) => {
    if (r.terrain !== 'cave' && r.terrain !== 'dungeon') return;
    const z = regionZones[i];
    if (z) for (const cell of z.cells) cells.add(cell);
  });
  return cells;
}
