/**
 * Biome richness (Roadmap v2 · M3). The `clearing` feature ramps a forest's
 * trees toward the edges (open glade in the middle); enclosed mouths spill an
 * ecotone apron of rock ground into the open band so entrances read as carved in.
 */
import { describe, it, expect } from 'vitest';
import { composeMap, composeRegions } from '../MapComposer.js';

const TREE = 110;
const CAVE_GRAVEL = 303;

describe('clearing density ramp (#6)', () => {
  it('thins the forest centre relative to its edges', () => {
    const W = 30, H = 22, m = composeMap({ terrain: 'forest', features: ['clearing'], width: W, height: H, seed: 5 });
    const cx = (W - 1) / 2, cy = (H - 1) / 2, maxD = Math.hypot(cx, cy);
    let cTrees = 0, cCells = 0, eTrees = 0, eCells = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const tree = (m.objectData[y * W + x] & 0x1fffffff) === TREE ? 1 : 0;
      if (d < 0.3) { cTrees += tree; cCells++; } else if (d > 0.7) { eTrees += tree; eCells++; }
    }
    const centre = cTrees / cCells, edge = eTrees / eCells;
    expect(centre).toBeLessThan(edge);
    expect(centre).toBeLessThan(0.02); // the glade is genuinely open
  });

  it('a plain forest is denser in the centre than a cleared one (opt-in, additive)', () => {
    const plain = composeMap({ terrain: 'forest', features: [], width: 30, height: 22, seed: 5 });
    const cleared = composeMap({ terrain: 'forest', features: ['clearing'], width: 30, height: 22, seed: 5 });
    const centreTrees = (m: { objectData: number[] }) => {
      let n = 0;
      for (let y = 8; y < 14; y++) for (let x = 11; x < 19; x++) if ((m.objectData[y * 30 + x] & 0x1fffffff) === TREE) n++;
      return n;
    };
    expect(centreTrees(cleared)).toBeLessThan(centreTrees(plain));
  });
});

describe('ecotone mouth aprons (#7)', () => {
  it('spills rock ground into the open band around a cave mouth', () => {
    const W = 40, H = 18;
    const m = composeRegions({ width: W, height: H, regions: [{ terrain: 'grassland' }, { terrain: 'cave' }], seed: 3 });
    const grassZone = (m.zones ?? []).find((z) => z.id.includes('_region_') && z.name === 'grassland')!;
    expect(grassZone).toBeDefined();
    const grass = new Set(grassZone.cells);
    let gravelInGrass = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((m.terrainData[y * W + x] & 0x1fffffff) === CAVE_GRAVEL && grass.has(`${x},${y}`)) gravelInGrass++;
    }
    // A spread of rock ground in the open band, wider than the bare mouth corridor.
    expect(gravelInGrass).toBeGreaterThan(4);
  });

  it('is deterministic', () => {
    const opts = { width: 40, height: 18, regions: [{ terrain: 'grassland' as const }, { terrain: 'cave' as const }], seed: 3 };
    expect(composeRegions(opts).terrainData).toEqual(composeRegions(opts).terrainData);
  });
});
