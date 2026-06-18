/**
 * Path-to-feature routing (Roadmap v2 · M4/#4). A road is threaded from a map
 * edge to each placed structure's doorstep, reaching the wall without cutting
 * through any footprint, and the map stays connected.
 */
import { describe, it, expect } from 'vitest';
import { composeTerrainWithFeature } from '../MapComposer.js';
import { MapCanvas } from './MapCanvas.js';
import { passableRegions } from './mapOps.js';
import { PATH_GIDS } from '../mapTiles.js';

const PATH_BASE = new Set([PATH_GIDS.V, PATH_GIDS.H, PATH_GIDS.INTERSECTION, PATH_GIDS.CORNER_SE, PATH_GIDS.CORNER_SW, PATH_GIDS.CORNER_NW, PATH_GIDS.CORNER_NE].map((g) => g & 0x1fffffff));

function canvasOf(m: { width: number; height: number; terrainData: number[]; objectData: number[] }): MapCanvas {
  const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    c.setGround(x, y, m.terrainData[y * m.width + x]);
    c.setObject(x, y, m.objectData[y * m.width + x]);
  }
  return c;
}

describe('connectPlaceablesByRoad', () => {
  it('threads a road to a placeable, reaching its wall and a map edge, without cutting the footprint', () => {
    const m = composeTerrainWithFeature({ width: 30, height: 22, terrain: 'grassland', placeables: [{ id: 'tavern', rooms: 2 }], seed: 4, roadToPlaceables: true });
    const W = m.width, H = m.height;
    const isPath = (x: number, y: number): boolean => PATH_BASE.has(m.objectData[y * W + x] & 0x1fffffff);
    const pathZone = (m.zones ?? []).find((z) => z.name === 'path');
    expect(pathZone, 'a path zone was laid').toBeDefined();

    // A path tile touches the map edge (the road starts at the border).
    let touchesEdge = false;
    for (let x = 0; x < W; x++) { if (isPath(x, 0) || isPath(x, H - 1)) touchesEdge = true; }
    for (let y = 0; y < H; y++) { if (isPath(0, y) || isPath(W - 1, y)) touchesEdge = true; }
    expect(touchesEdge, 'road reaches a map edge').toBe(true);

    // A path tile sits orthogonally adjacent to the placeable footprint (doorstep).
    const fp = (m.placements ?? [])[0];
    expect(fp).toBeDefined();
    let touchesStructure = false;
    for (let yy = fp.y; yy < fp.y + fp.h; yy++) {
      if (isPath(fp.x - 1, yy) || isPath(fp.x + fp.w, yy)) touchesStructure = true;
    }
    for (let xx = fp.x; xx < fp.x + fp.w; xx++) {
      if (isPath(xx, fp.y - 1) || isPath(xx, fp.y + fp.h)) touchesStructure = true;
    }
    expect(touchesStructure, 'road reaches the structure doorstep').toBe(true);

    // No path tile sits INSIDE the footprint.
    for (let yy = fp.y; yy < fp.y + fp.h; yy++) for (let xx = fp.x; xx < fp.x + fp.w; xx++) {
      expect(isPath(xx, yy), `no road inside footprint at ${xx},${yy}`).toBe(false);
    }

    // Still walkable.
    expect(Math.max(...passableRegions(canvasOf(m)).sizes)).toBeGreaterThan(W * H * 0.4);
  });

  it('is deterministic', () => {
    const opts = { width: 30, height: 22, terrain: 'grassland' as const, placeables: [{ id: 'watchtower' }], seed: 7, roadToPlaceables: true };
    expect(composeTerrainWithFeature(opts).objectData).toEqual(composeTerrainWithFeature(opts).objectData);
  });
});
