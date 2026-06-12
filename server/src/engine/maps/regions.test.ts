/**
 * US-126 — multi-region big maps. The composer must be deterministic, lay
 * out every region as a non-empty named zone (dark by default for enclosed
 * biomes), and guarantee the player can walk from the first region to the
 * last — the cave is entered through a carved mouth, never sealed off.
 */
import { describe, it, expect } from 'vitest';
import { composeRegions } from './regions.js';
import { MapCanvas } from './MapCanvas.js';
import { passableRegions } from './mapOps.js';
import type { ComposedMap } from '../mapTypes.js';

const TREE = 110;

function compose(seed = 42): ComposedMap {
  return composeRegions({
    width: 60, height: 24, seed,
    regions: [
      { terrain: 'grassland', name: 'the Reach meadows' },
      { terrain: 'forest', name: 'the Wardwood' },
      { terrain: 'cave', name: 'the Hollow', share: 0.8 },
    ],
  });
}

/** Rebuild a canvas from composed data so mapOps' flood-fill can read it. */
function canvasOf(m: ComposedMap): MapCanvas {
  const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      c.setGround(x, y, m.terrainData[y * m.width + x]);
      c.setObject(x, y, m.objectData[y * m.width + x]);
    }
  }
  return c;
}

describe('composeRegions (US-126)', () => {
  it('is deterministic: same seed + options → identical map', () => {
    const a = compose(7);
    const b = compose(7);
    expect(a.terrainData).toEqual(b.terrainData);
    expect(a.objectData).toEqual(b.objectData);
    expect(a.zones).toEqual(b.zones);
  });

  it('emits exact dimensions and one non-empty zone per region, in order', () => {
    const m = compose();
    expect(m.width).toBe(60);
    expect(m.height).toBe(24);
    expect(m.terrainData.length).toBe(60 * 24);
    expect(m.objectData.length).toBe(60 * 24);
    expect(m.zones?.length).toBe(3);
    expect(m.zones![0].name).toBe('the Reach meadows');
    expect(m.zones![1].name).toBe('the Wardwood');
    expect(m.zones![2].name).toBe('the Hollow');
    for (const z of m.zones!) expect(z.cells.length).toBeGreaterThan(20);
  });

  it('defaults enclosed regions to dark and leaves open regions unlit', () => {
    const m = compose();
    expect(m.zones![0].lightLevel).toBeUndefined();
    expect(m.zones![1].lightLevel).toBeUndefined();
    expect(m.zones![2].lightLevel).toBe('dark');
  });

  it('honours an explicit region light override', () => {
    const m = composeRegions({
      width: 48, height: 20, seed: 3,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest', light: 'dim' }],
    });
    expect(m.zones![1].lightLevel).toBe('dim');
  });

  it('connects every region: entrance and vault share one passable component', () => {
    for (const seed of [1, 2, 3, 99, 1234]) {
      const m = compose(seed);
      const { labels } = passableRegions(canvasOf(m));
      const entrance = m.anchors.entrance!;
      const vault = m.anchors.vault!;
      const home = labels[entrance.y][entrance.x];
      expect(home).toBeGreaterThanOrEqual(0);
      expect(labels[vault.y][vault.x]).toBe(home);
    }
  });

  it('thickens trees across the grass→forest ecotone instead of jumping', () => {
    const m = compose(11);
    const countTrees = (zoneIdx: number): number => {
      let trees = 0;
      for (const cell of m.zones![zoneIdx].cells) {
        const [x, y] = cell.split(',').map(Number);
        if ((m.objectData[y * m.width + x] & 0x1fffffff) === TREE) trees++;
      }
      return trees;
    };
    const grasslandTrees = countTrees(0) / m.zones![0].cells.length;
    const forestTrees = countTrees(1) / m.zones![1].cells.length;
    expect(forestTrees).toBeGreaterThan(grasslandTrees);
  });

  it('rejects bad inputs: too few regions, oversize, bands too narrow', () => {
    expect(() => composeRegions({ width: 60, height: 24, seed: 1, regions: [{ terrain: 'grassland' }] })).toThrow();
    expect(() => composeRegions({ width: 120, height: 24, seed: 1, regions: [{ terrain: 'grassland' }, { terrain: 'cave' }] })).toThrow();
    expect(() => composeRegions({
      width: 24, height: 16, seed: 1,
      regions: [{ terrain: 'grassland' }, { terrain: 'forest' }, { terrain: 'urban' }, { terrain: 'cave' }, { terrain: 'dungeon' }],
    })).toThrow();
  });
});
