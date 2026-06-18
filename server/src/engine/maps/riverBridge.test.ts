/**
 * River + bridge (Roadmap v2 · M5/#5). A river splits the map into two banks; a
 * bridge placed across it (a wood-floor deck spanning the water) reconnects them.
 */
import { describe, it, expect } from 'vitest';
import { composeMap, composeTerrainWithFeature } from '../MapComposer.js';
import { MapCanvas } from './MapCanvas.js';
import { passableRegions } from './mapOps.js';
import { groundGid } from './materials.js';
import { WATER_FIRSTGID, PATH_GIDS } from '../mapTiles.js';

const PATH_BASE = new Set([PATH_GIDS.V, PATH_GIDS.H, PATH_GIDS.INTERSECTION, PATH_GIDS.CORNER_SE, PATH_GIDS.CORNER_SW, PATH_GIDS.CORNER_NW, PATH_GIDS.CORNER_NE].map((g) => g & 0x1fffffff));

function canvasOf(m: { width: number; height: number; terrainData: number[]; objectData: number[] }): MapCanvas {
  const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    c.setGround(x, y, m.terrainData[y * m.width + x]);
    c.setObject(x, y, m.objectData[y * m.width + x]);
  }
  return c;
}

describe('river feature + bridge placeable', () => {
  it('a river carves water across the map', () => {
    const m = composeMap({ terrain: 'grassland', features: ['river'], width: 40, height: 20, seed: 5 });
    const water = m.terrainData.filter((g) => { const lo = g & 0x1fffffff; return lo >= WATER_FIRSTGID && lo < WATER_FIRSTGID + 16; }).length;
    expect(water).toBeGreaterThan(40); // a 2-wide band across a 40-wide map
  });

  it('a bridge reconnects the two banks a river separates', () => {
    const seed = 5, W = 40, H = 20;
    const river = composeMap({ terrain: 'grassland', features: ['river'], width: W, height: H, seed });
    const bridged = composeTerrainWithFeature({ terrain: 'grassland', features: ['river'], placeables: [{ id: 'bridge' }], width: W, height: H, seed });

    const fp = (bridged.placements ?? [])[0];
    expect(fp, 'bridge was placed').toBeDefined();
    expect((bridged.zones ?? []).some((z) => z.name === 'bridge')).toBe(true);
    // The deck is walkable wood floor laid over the river.
    const wood = groundGid('wood_floor')! & 0x1fffffff;
    expect(bridged.terrainData[(fp.y + (fp.h >> 1)) * W + fp.x + (fp.w >> 1)] & 0x1fffffff).toBe(wood);

    // Bank cells straddling the deck: separated in the plain river, joined once bridged.
    const bx = fp.x + (fp.w >> 1), above = fp.y - 1, below = fp.y + fp.h;
    const rl = passableRegions(canvasOf(river)).labels;
    const bl = passableRegions(canvasOf(bridged)).labels;
    expect(rl[above][bx]).not.toBe(rl[below][bx]);     // river keeps the banks apart
    expect(bl[above][bx]).toBe(bl[below][bx]);          // the bridge joins them
  });

  it('a bridge lines up with a path crossing the river — one continuous road', () => {
    const W = 40, H = 20;
    const m = composeTerrainWithFeature({ terrain: 'grassland', features: ['river', 'path'], placeables: [{ id: 'bridge' }], width: W, height: H, seed: 5 });
    const fp = (m.placements ?? [])[0];
    expect(fp).toBeDefined();
    const isPath = (x: number, y: number): boolean => PATH_BASE.has(m.objectData[y * W + x] & 0x1fffffff);

    // A deck column carries the road all the way across the river, joining the
    // bank path above and below — the bridge and path are aligned, not separate.
    let aligned = false;
    for (let col = fp.x; col < fp.x + fp.w; col++) {
      if (!isPath(col, fp.y - 1) || !isPath(col, fp.y + fp.h)) continue;
      let allDeck = true;
      for (let ry = fp.y; ry < fp.y + fp.h; ry++) if (!isPath(col, ry)) { allDeck = false; break; }
      if (allDeck) { aligned = true; break; }
    }
    expect(aligned, 'the path runs continuously across the bridge deck').toBe(true);
  });
});
