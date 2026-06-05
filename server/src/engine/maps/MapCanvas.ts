/**
 * MapCanvas — the shared mutable substrate every map-building operation writes
 * to. It bundles the two GID grids (ground + object), the deterministic RNG,
 * the author-time anchors/zones, and a `reserved` set the structure placers
 * use to avoid overlapping each other.
 *
 * Today the per-terrain composers each carry these as loose locals threaded
 * through their feature placers (see `outdoor.ts` / `dungeon.ts` / `tavern.ts`).
 * The canvas hoists that state into one object so the SAME operations can be
 * driven two ways:
 *   • deterministically, by `composeMap` (fixed terrain + feature toggles), and
 *   • interactively, by the agentic AI generator, which calls the operations as
 *     tools and reads back the canvas after each step.
 *
 * The canvas owns correctness invariants (bounds, layer separation, zone-id
 * determinism); the operations in `mapOps.ts` own composition (what goes where).
 */
import type { ComposedMap, MapAnchors, MapZone } from '../mapTypes.js';
import { mulberry32, makeZoneIdAlloc, flatten, tilesetsForGids } from './shared.js';

export interface MapCanvasOptions {
  width: number;
  height: number;
  /** Seed for the deterministic RNG + zone-id allocator. Same seed + same
   *  operation sequence → byte-identical map. Required (no Date.now fallback —
   *  callers decide the seed so output is always reproducible). */
  seed: number;
}

export class MapCanvas {
  readonly width: number;
  readonly height: number;
  /** Ground layer GIDs. 0 = void (no floor) — valid for caves/dungeons. */
  readonly terrain: number[][];
  /** Object overlay GIDs. 0 = empty. */
  readonly objects: number[][];
  /** Deterministic [0,1) PRNG. */
  readonly rng: () => number;
  /** Story-suitable spawn anchors accumulated by structure placers. */
  readonly anchors: MapAnchors = {};
  /** Author-time named regions accumulated by `defineZone` and placers. */
  readonly zones: MapZone[] = [];
  /** Cells claimed by a structure ("x,y"), so later placers don't overlap. */
  readonly reserved = new Set<string>();
  private readonly allocZoneId: (kind: string) => string;

  constructor(opts: MapCanvasOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.rng = mulberry32(opts.seed & 0xffffffff);
    this.allocZoneId = makeZoneIdAlloc(opts.seed & 0xffffffff);
    this.terrain = Array.from({ length: opts.height }, () => new Array<number>(opts.width).fill(0));
    this.objects = Array.from({ length: opts.height }, () => new Array<number>(opts.width).fill(0));
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  key(x: number, y: number): string {
    return `${x},${y}`;
  }

  isReserved(x: number, y: number): boolean {
    return this.reserved.has(this.key(x, y));
  }

  reserve(x: number, y: number): void {
    if (this.inBounds(x, y)) this.reserved.add(this.key(x, y));
  }

  getGround(x: number, y: number): number {
    return this.inBounds(x, y) ? this.terrain[y][x] : 0;
  }

  getObject(x: number, y: number): number {
    return this.inBounds(x, y) ? this.objects[y][x] : 0;
  }

  /** Write a ground GID. Out-of-bounds writes are silently ignored so callers
   *  can paint with overscan without bounds-checking every cell. */
  setGround(x: number, y: number, gid: number): void {
    if (this.inBounds(x, y)) this.terrain[y][x] = gid;
  }

  setObject(x: number, y: number, gid: number): void {
    if (this.inBounds(x, y)) this.objects[y][x] = gid;
  }

  /** Allocate a deterministic zone id and append a named zone. `kind` seeds the
   *  id; `cells` are sorted for stable output. Returns the zone id. */
  addZone(kind: string, name: string, color: string, cells: Iterable<string>): string {
    const id = this.allocZoneId(kind);
    this.zones.push({ id, name, color, cells: [...cells].sort() });
    return id;
  }

  /** Render the canvas into the persisted `ComposedMap` shape. Tilesets are
   *  derived from the GIDs actually used (firstgid-aware), so a map that paints
   *  water or cave tiles automatically declares those tilesets. */
  toComposedMap(name: string, description: string): ComposedMap {
    const terrainData = flatten(this.terrain);
    const objectData = flatten(this.objects);
    return {
      width: this.width,
      height: this.height,
      terrainData,
      objectData,
      name,
      description,
      tilesets: tilesetsForGids([...terrainData, ...objectData]),
      anchors: this.anchors,
      ...(this.zones.length > 0 ? { zones: this.zones } : {}),
    };
  }
}
