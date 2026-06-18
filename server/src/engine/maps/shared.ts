/**
 * Shared helpers used by every per-terrain composer module.
 *
 * The per-terrain modules (`outdoor.ts`, `dungeon.ts`, `cave.ts`, `urban.ts`)
 * live under `engine/maps/` and each export a single `compose<Terrain>` function.
 * This file holds the small primitives they all need: tileset refs, the
 * mulberry32 PRNG, the row-major flatten, the disabled-tile palette
 * filter, and a zone-id allocator that produces deterministic, unique ids
 * per `composeMap` call.
 */
import type { BiomePalette } from '../../../../shared/biomePalettes.js';
import type { ComposedTilesetRef } from '../mapTypes.js';
import { WATER_FIRSTGID, CAVE_URBAN_FIRSTGID } from '../mapTiles.js';

export const SCRIBBLE_TILESET:    ComposedTilesetRef = { firstgid: 1, source: '../tilesets/scribble.tsj' };
export const WATER_TILESET:       ComposedTilesetRef = { firstgid: WATER_FIRSTGID, source: '../tilesets/water.tsj' };
export const CAVE_URBAN_TILESET:  ComposedTilesetRef = { firstgid: CAVE_URBAN_FIRSTGID, source: '../tilesets/cave_and_urban_floors.tsj' };

/**
 * The tilesets the AI map generator may draw from, paired with the tileset
 * name used to key `GameDefs.tileLegendsByTileset`. Order is the firstgid
 * order; `tilesetsForGids` and the global-GID legend builder both rely on it.
 * Adding a tileset here is all it takes to offer it to the generator.
 */
export const AI_PALETTE_TILESETS: ReadonlyArray<{ name: string; ref: ComposedTilesetRef }> = [
  { name: 'scribble',              ref: SCRIBBLE_TILESET },
  { name: 'water',                 ref: WATER_TILESET },
  { name: 'cave_and_urban_floors', ref: CAVE_URBAN_TILESET },
];

/**
 * Name of the AI-palette tileset that owns a (flag-stripped) GID — the entry
 * with the largest firstgid ≤ gid. This is exactly how SessionBuilder routes
 * a GID back to its legend, so anything that wants its tiles to resolve at
 * play time must agree with it. Returns undefined for gid ≤ 0.
 */
export function ownerTilesetName(rawGid: number): string | undefined {
  const gid = rawGid & 0x1fffffff; // strip Tiled flip/rotation flags
  if (gid <= 0) return undefined;
  let owner: { name: string; ref: ComposedTilesetRef } | undefined;
  for (const entry of AI_PALETTE_TILESETS) {
    if (entry.ref.firstgid <= gid && (!owner || entry.ref.firstgid > owner.ref.firstgid)) owner = entry;
  }
  return owner?.name;
}

/**
 * Given every GID a map references, return the tileset refs whose global-GID
 * range owns at least one of them — the `tilesets[]` a generated map must
 * declare so each GID resolves to the right tile.
 */
export function tilesetsForGids(gids: Iterable<number>): ComposedTilesetRef[] {
  const usedNames = new Set<string>();
  for (const raw of gids) {
    const name = ownerTilesetName(raw);
    if (name) usedNames.add(name);
  }
  return AI_PALETTE_TILESETS
    .filter((e) => usedNames.has(e.name))
    .map((e) => e.ref)
    .sort((a, b) => a.firstgid - b.firstgid);
}

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
