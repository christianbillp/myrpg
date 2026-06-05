/**
 * Tavern composition invariants. The headline check: every chair faces a table
 * (its rotation points at an adjacent table cell), so the common room reads as
 * set tables rather than chairs scattered at random angles.
 */
import { describe, it, expect } from "vitest";
import { composeMap } from "../MapComposer.js";
import { decodeTileGid } from "../../../../shared/tileGid.js";
import { FURNITURE_GIDS } from "../mapTiles.js";

/** Unit vector a chair at the given decoded angle faces (art faces north at 0°). */
const FACING: Record<number, [number, number]> = {
  0: [0, -1],   // north
  90: [1, 0],   // east
  180: [0, 1],  // south
  270: [-1, 0], // west
};

describe("composeTavern", () => {
  it("every chair faces an adjacent table", () => {
    let totalChairs = 0;
    for (const seed of [14, 7, 99, 3, 42, 1234]) {
      const m = composeMap({ terrain: "tavern", features: [], width: 26, height: 14, seed });
      const W = m.width, H = m.height, o = m.objectData;
      const base = (g: number): number => decodeTileGid(g).gid;
      for (let i = 0; i < o.length; i++) {
        if (base(o[i]) !== FURNITURE_GIDS.CHAIR) continue;
        totalChairs++;
        const x = i % W, y = Math.floor(i / W);
        const angle = ((decodeTileGid(o[i]).angle % 360) + 360) % 360;
        const [dx, dy] = FACING[angle];
        const fx = x + dx, fy = y + dy;
        const faced = fx >= 0 && fx < W && fy >= 0 && fy < H ? base(o[fy * W + fx]) : 0;
        expect(faced, `seed ${seed} chair@(${x},${y}) angle ${angle} should face a table`).toBe(FURNITURE_GIDS.WOODEN_PLANK);
      }
    }
    expect(totalChairs).toBeGreaterThan(0);
  });
});
