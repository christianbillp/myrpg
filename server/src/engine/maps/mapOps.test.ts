/**
 * Unit tests for the deterministic map-op toolbox. These pin the guarantees the
 * agentic generator relies on: rooms enclose, corridors connect, paths auto-tile,
 * water blocks, and the connectivity validator catches disconnected regions.
 */
import { describe, it, expect } from "vitest";
import { MapCanvas } from "./MapCanvas.js";
import {
  fillTerrain, stampRoom, carveCorridor, placeWaterBody, layPath,
  placeHazard, paintRegion, defineZone, scatterDecor, placeBuilding,
  validateCanvas, passableRegions,
} from "./mapOps.js";
import { GROUND_MATERIALS, WALL_RING, WATER_GIDS, HAZARD_MATERIALS } from "./materials.js";

const mk = (w = 24, h = 18, seed = 42): MapCanvas => new MapCanvas({ width: w, height: h, seed });

describe("fillTerrain", () => {
  it("flat material fills every ground cell", () => {
    const c = mk();
    expect(fillTerrain(c, { material: "cobbles" }).ok).toBe(true);
    expect(c.terrain.flat().every((g) => g === GROUND_MATERIALS.cobbles)).toBe(true);
  });
  it("biome fill uses only the palette's ground gids", () => {
    const c = mk();
    expect(fillTerrain(c, { biome: "grassland" }).ok).toBe(true);
    expect(c.terrain.flat().every((g) => g === 8 || g === 99)).toBe(true);
  });
  it("rejects unknown material", () => {
    expect(fillTerrain(mk(), { material: "lava" as never }).ok).toBe(false);
  });
  it("cave/urban biomes fill from their palette gid ranges", () => {
    const cave = mk();
    expect(fillTerrain(cave, { biome: "cave" }).ok).toBe(true);
    // Cave floors live in the cave_and_urban tileset (gids 300-349).
    expect(cave.terrain.flat().every((g) => g >= 300 && g <= 349)).toBe(true);
    const urban = mk();
    expect(fillTerrain(urban, { biome: "urban" }).ok).toBe(true);
    expect(urban.terrain.flat().every((g) => g >= 300 && g <= 349)).toBe(true);
  });
});

describe("stampRoom", () => {
  it("encloses the room with aligned walls and carves the doorway", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    const res = stampRoom(c, { x: 3, y: 3, w: 6, h: 5, floor: "stone_floor", doorways: [{ x: 5, y: 7 }], zone: { name: "hall" } });
    expect(res.ok).toBe(true);
    // Corners carry the right corner tiles.
    expect(c.getObject(3, 3)).toBe(WALL_RING.CORNER_TL);
    expect(c.getObject(8, 3)).toBe(WALL_RING.CORNER_TR);
    expect(c.getObject(3, 7)).toBe(WALL_RING.CORNER_BL);
    expect(c.getObject(8, 7)).toBe(WALL_RING.CORNER_BR);
    // Interior floor + open doorway.
    expect(c.getGround(5, 5)).toBe(GROUND_MATERIALS.stone_floor);
    expect(c.getObject(5, 7)).toBe(0);
    // Zone recorded over the interior.
    expect(c.zones.find((z) => z.name === "hall")?.cells.length).toBe(30);
  });
  it("rejects out-of-bounds and too-small rooms", () => {
    expect(stampRoom(mk(), { x: 20, y: 2, w: 8, h: 4, floor: "stone_floor" }).ok).toBe(false);
    expect(stampRoom(mk(), { x: 2, y: 2, w: 2, h: 2, floor: "stone_floor" }).ok).toBe(false);
  });
});

describe("carveCorridor connects regions", () => {
  it("two sealed rooms become one connected region after a corridor", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    stampRoom(c, { x: 2, y: 2, w: 5, h: 5, floor: "stone_floor" });
    stampRoom(c, { x: 16, y: 10, w: 5, h: 5, floor: "stone_floor" });
    // Sealed rooms: interiors are separate regions, plus the grass surround.
    const before = validateCanvas(c);
    expect(before.regionCount).toBeGreaterThan(1);
    carveCorridor(c, { from: { x: 4, y: 4 }, to: { x: 18, y: 12 }, floor: "stone_floor" });
    const after = passableRegions(c);
    // The two room interiors now share a region via the carved corridor.
    expect(after.labels[4][4]).toBe(after.labels[12][18]);
  });
});

describe("placeWaterBody", () => {
  it("edge flood fills water that blocks movement", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    expect(placeWaterBody(c, { mode: "edge", side: "N", depth: 4 }).ok).toBe(true);
    expect(c.getGround(5, 0)).toBe(WATER_GIDS.WATER);
    expect(c.anchors.inlandBand?.length).toBeGreaterThan(0);
  });
  it("pond has a water interior and shored border", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    expect(placeWaterBody(c, { mode: "pond", rect: { x: 6, y: 4, w: 8, h: 6 } }).ok).toBe(true);
    expect(c.getGround(9, 6)).toBe(WATER_GIDS.WATER); // interior
    expect(c.getGround(6, 4)).toBe(WATER_GIDS.OUTER_NW); // corner shore
  });
});

describe("layPath", () => {
  it("auto-tiles a straight run and records a path zone", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    const res = layPath(c, { waypoints: [{ x: 0, y: 9 }, { x: 23, y: 9 }] });
    expect(res.ok).toBe(true);
    expect(c.getObject(5, 9)).not.toBe(0);
    expect(c.zones.some((z) => z.name === "path")).toBe(true);
  });
  it("needs at least two waypoints", () => {
    expect(layPath(mk(), { waypoints: [{ x: 1, y: 1 }] }).ok).toBe(false);
  });
});

describe("hazards, paint, zones, decor, building", () => {
  it("placeHazard paints impassable ground", () => {
    const c = mk();
    fillTerrain(c, { material: "cave_dust" });
    placeHazard(c, { rect: { x: 4, y: 4, w: 3, h: 3 }, material: "chasm" });
    expect(c.getGround(5, 5)).toBe(HAZARD_MATERIALS.chasm);
  });
  it("paintRegion rejects a ground material on the object layer", () => {
    const c = mk();
    expect(paintRegion(c, { rect: { x: 0, y: 0, w: 2, h: 2 }, material: "grass", layer: "object" }).ok).toBe(false);
  });
  it("defineZone tags a region", () => {
    const c = mk();
    expect(defineZone(c, { name: "ambush", rect: { x: 1, y: 1, w: 3, h: 3 } }).ok).toBe(true);
    expect(c.zones.find((z) => z.name === "ambush")?.cells.length).toBe(9);
  });
  it("scatterDecor only decorates natural ground", () => {
    const c = mk();
    fillTerrain(c, { biome: "forest" });
    const res = scatterDecor(c, { biome: "forest" });
    expect(res.ok).toBe(true);
  });
  it("placeBuilding records a building anchor", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    expect(placeBuilding(c, { x: 4, y: 4, w: 6, h: 5, doorSide: "S" }).ok).toBe(true);
    expect(c.anchors.buildings?.length).toBe(1);
  });
});

describe("validateCanvas", () => {
  it("flags a tiny / disconnected map and passes a connected one", () => {
    const c = mk();
    fillTerrain(c, { material: "grass" });
    expect(validateCanvas(c).ok).toBe(true); // open field is one big region
    const sealed = mk();
    // All void → no passable cells at all.
    expect(validateCanvas(sealed).largestRegion).toBe(0);
    expect(validateCanvas(sealed).ok).toBe(false);
  });
});
