/**
 * Shared helpers used by every per-terrain composer module.
 *
 * The per-terrain modules (`outdoor.ts`, `dungeon.ts`, `tavern.ts`) live
 * under `engine/maps/` and each export a single `compose<Terrain>` function.
 * This file holds the small primitives they all need: tileset refs, the
 * mulberry32 PRNG, the row-major flatten, the disabled-tile palette
 * filter, and a zone-id allocator that produces deterministic, unique ids
 * per `composeMap` call.
 */
import type { BiomePalette } from '../../../../shared/biomePalettes.js';
import type { ComposedTilesetRef } from '../mapTypes.js';
import { WATER_FIRSTGID } from '../mapTiles.js';

export const SCRIBBLE_TILESET: ComposedTilesetRef = { firstgid: 1, source: '../tilesets/scribble.tsj' };
export const WATER_TILESET:    ComposedTilesetRef = { firstgid: WATER_FIRSTGID, source: '../tilesets/water.tsj' };

/** Mulberry32 — small deterministic 32-bit PRNG. Returns a [0, 1) float per call. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0)) / 4294967296;
  };
}

/** Row-major flatten of a 2D number grid. */
export function flatten(grid: number[][]): number[] {
  const out: number[] = [];
  for (const row of grid) out.push(...row);
  return out;
}


/**
 * Make a zone-id allocator scoped to a single `composeMap` call. Each call
 * produces ids of the form `zone_<kind>_<seedHex>_<counter>` so a given
 * seed yields the same id sequence every time — useful for diff stability
 * and tests. The same allocator is threaded through every feature placer
 * so two placers in the same call can't collide.
 */
export function makeZoneIdAlloc(seed: number): (kind: string) => string {
  const seedHex = (seed >>> 0).toString(36);
  let counter = 0;
  return (kind: string) => `zone_${kind}_${seedHex}_${(++counter).toString(36)}`;
}
