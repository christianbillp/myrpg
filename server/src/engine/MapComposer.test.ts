/**
 * Seed-stability safety net for the deterministic map composer.
 *
 * `composeMap` is a pure function of its options + seed. This test pins the
 * exact output (via a content hash) for a representative matrix of
 * terrain/feature/size/seed combinations. Its job is to guard the Phase 0
 * `MapCanvas` refactor: extracting the composers onto a shared canvas must
 * leave every byte of the rendered output identical, so these hashes must not
 * change. If a future change INTENTIONALLY alters composition, regenerate the
 * snapshot with `vitest -u` — but never as a silent side effect of a refactor.
 */
import { describe, it, expect } from "vitest";
import { composeMap } from "./MapComposer.js";
import type { ComposeOptions } from "./mapTypes.js";
import { MapCanvas } from "./maps/MapCanvas.js";
import { passableRegions } from "./maps/mapOps.js";

/** FNV-1a over the canonical JSON of a composed map. Stable across runs and
 *  machines (no Date.now / Math.random in the composer when a seed is given). */
function hashMap(opts: ComposeOptions): string {
  const map = composeMap(opts);
  const json = JSON.stringify({
    width: map.width,
    height: map.height,
    terrainData: map.terrainData,
    objectData: map.objectData,
    name: map.name,
    description: map.description,
    tilesets: map.tilesets,
    anchors: map.anchors,
    zones: map.zones ?? null,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const CASES: Array<{ label: string; opts: ComposeOptions }> = [
  { label: "grassland/bare",                  opts: { terrain: "grassland", features: [], width: 30, height: 22, seed: 1 } },
  { label: "grassland/coastline",             opts: { terrain: "grassland", features: ["coastline"], width: 30, height: 22, seed: 2 } },
  { label: "grassland/path",                  opts: { terrain: "grassland", features: ["path"], width: 30, height: 22, seed: 3 } },
  { label: "grassland/intersection",          opts: { terrain: "grassland", features: ["intersection"], width: 30, height: 22, seed: 4 } },
  { label: "grassland/coastline+intersection",opts: { terrain: "grassland", features: ["coastline", "intersection"], width: 30, height: 22, seed: 5 } },
  { label: "grassland/buildings3",            opts: { terrain: "grassland", features: [], structures: [{ type: "building", rooms: 1 }, { type: "building", rooms: 1 }, { type: "building", rooms: 1 }], width: 30, height: 22, seed: 6 } },
  { label: "grassland/multiroom",             opts: { terrain: "grassland", features: [], structures: [{ type: "building", rooms: 3 }], width: 30, height: 22, seed: 21 } },
  { label: "grassland/campsites",             opts: { terrain: "grassland", features: ["campsites"], width: 30, height: 22, seed: 7 } },
  { label: "grassland/ruins",                 opts: { terrain: "grassland", features: [], structures: [{ type: "ruin", rooms: 1 }, { type: "ruin", rooms: 1 }, { type: "ruin", rooms: 1 }], width: 30, height: 22, seed: 18 } },
  { label: "grassland/ruin-multiroom",        opts: { terrain: "grassland", features: [], structures: [{ type: "ruin", rooms: 4 }], width: 30, height: 22, seed: 22 } },
  { label: "grassland/everything",            opts: { terrain: "grassland", features: ["coastline", "path", "campsites"], structures: [{ type: "building", rooms: 2 }, { type: "ruin", rooms: 1 }], width: 30, height: 22, seed: 8 } },
  { label: "grassland/small",                 opts: { terrain: "grassland", features: ["path"], width: 14, height: 10, seed: 9 } },
  { label: "forest/bare",                     opts: { terrain: "forest", features: [], width: 30, height: 22, seed: 10 } },
  { label: "forest/path+campsites",           opts: { terrain: "forest", features: ["path", "campsites"], width: 30, height: 22, seed: 11 } },
  { label: "dungeon/3-room",                  opts: { terrain: "dungeon", features: ["3-room"], width: 30, height: 22, seed: 12 } },
  { label: "dungeon/5-room",                  opts: { terrain: "dungeon", features: ["5-room"], width: 30, height: 22, seed: 13 } },
  { label: "cave/small",                      opts: { terrain: "cave", features: [], width: 30, height: 22, seed: 15 } },
  { label: "cave/large",                      opts: { terrain: "cave", features: ["5-room"], width: 30, height: 22, seed: 16 } },
  { label: "cave/stairs",                     opts: { terrain: "cave", features: ["stairs"], width: 30, height: 22, seed: 15 } },
  { label: "dungeon/stairs",                  opts: { terrain: "dungeon", features: ["3-room", "stairs"], width: 30, height: 22, seed: 12 } },
  { label: "urban",                           opts: { terrain: "urban", features: [], buildingsCount: 4, width: 30, height: 22, seed: 17 } },
];

describe("composeMap seed stability", () => {
  for (const { label, opts } of CASES) {
    it(`${label} is byte-stable`, () => {
      expect(hashMap(opts)).toMatchSnapshot();
    });
  }

  it("same seed → identical output; different seed → different", () => {
    const base: ComposeOptions = { terrain: "grassland", features: ["path"], structures: [{ type: "building", rooms: 2 }], width: 24, height: 18, seed: 1234 };
    expect(hashMap(base)).toBe(hashMap({ ...base }));
    expect(hashMap(base)).not.toBe(hashMap({ ...base, seed: 5678 }));
  });

  it("multi-room structures are internally connected and reachable from outside", () => {
    for (const rooms of [2, 3, 4, 5]) {
      const m = composeMap({ terrain: "grassland", features: [], structures: [{ type: "building", rooms }], width: 30, height: 22, seed: 100 + rooms });
      const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        c.setGround(x, y, m.terrainData[y * m.width + x]);
        c.setObject(x, y, m.objectData[y * m.width + x]);
      }
      const { labels } = passableRegions(c);
      // Every room's centre shares one region with an outside (corner) grass cell.
      const outside = labels[0][0];
      expect(outside, `rooms=${rooms} outside passable`).toBeGreaterThanOrEqual(0);
      const roomRects = m.anchors.buildings ?? [];
      expect(roomRects.length, `rooms=${rooms} room count`).toBe(rooms);
      for (const r of roomRects) {
        const cx = r.x + (r.w >> 1), cy = r.y + (r.h >> 1);
        expect(labels[cy][cx], `rooms=${rooms} room@(${cx},${cy}) reachable from outside`).toBe(outside);
      }
    }
  });

  it("output invariants hold for every case", () => {
    for (const { label, opts } of CASES) {
      const m = composeMap(opts);
      expect(m.terrainData.length, label).toBe(m.width * m.height);
      expect(m.objectData.length, label).toBe(m.width * m.height);
      // Outdoor + urban fill every ground cell; dungeons and caves
      // intentionally leave GID 0 (void) outside the carved floor, so the
      // no-holes invariant only applies to the space-filling terrains.
      if (opts.terrain !== "dungeon" && opts.terrain !== "cave") {
        expect(m.terrainData.every((g) => g !== 0), `${label} ground has no holes`).toBe(true);
      }
    }
  });
});
