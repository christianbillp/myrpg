/**
 * Terrain layout variety (Roadmap v2 · M2). Dungeons come in serial / branch /
 * loop silhouettes — all fully connected, loop variants genuinely loopier — and
 * caves in hub-spoke / cellular-automata cavern silhouettes, both one reachable
 * space.
 */
import { describe, it, expect } from 'vitest';
import { composeDungeon, type DungeonVariant } from './dungeon.js';
import { composeCave } from './cave.js';
import { MapCanvas } from './MapCanvas.js';
import { passableRegions } from './mapOps.js';
import { tacticalAnalysisOfMap } from './tactical.js';
import { makeZoneIdAlloc, mulberry32 } from './shared.js';

function canvasOf(m: { width: number; height: number; terrainData: number[]; objectData: number[] }): MapCanvas {
  const c = new MapCanvas({ width: m.width, height: m.height, seed: 1 });
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
    c.setGround(x, y, m.terrainData[y * m.width + x]);
    c.setObject(x, y, m.objectData[y * m.width + x]);
  }
  return c;
}

function dungeon(seed: number, variant: DungeonVariant) {
  return composeDungeon({ width: 34, height: 24, features: ['5-room'], rng: mulberry32(seed), allocZoneId: makeZoneIdAlloc(seed), variant });
}

describe('dungeon variants (M2/D1)', () => {
  it('every variant keeps all rooms in one connected region', () => {
    for (const variant of ['serial', 'branch', 'loop'] as DungeonVariant[]) {
      for (let seed = 1; seed <= 8; seed++) {
        const m = dungeon(seed, variant);
        const { labels } = passableRegions(canvasOf(m));
        const rooms = m.anchors.rooms ?? [];
        const home = labels[rooms[0].cy][rooms[0].cx];
        for (const r of rooms) expect(labels[r.cy][r.cx], `${variant} seed ${seed} room reachable`).toBe(home);
      }
    }
  });

  it('loop variants have fewer chokepoints than serial chains (alternate routes)', () => {
    // A serial chain makes every corridor cell a cut-vertex; loop corridors sit on
    // a cycle and so are NOT chokepoints. Summed across seeds the gap is decisive.
    let serialChokes = 0, loopChokes = 0;
    for (let seed = 1; seed <= 12; seed++) {
      serialChokes += tacticalAnalysisOfMap(dungeon(seed, 'serial')).chokepoints.length;
      loopChokes += tacticalAnalysisOfMap(dungeon(seed, 'loop')).chokepoints.length;
    }
    expect(loopChokes).toBeLessThan(serialChokes);
  });

  it('is deterministic for a forced variant + seed', () => {
    expect(dungeon(5, 'branch').objectData).toEqual(dungeon(5, 'branch').objectData);
  });
});

describe('cave variants (M2/D2)', () => {
  it('the CA cavern is one reachable space with a cavern zone + anchors', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const m = composeCave({ width: 36, height: 24, seed, variant: 'cavern' });
      expect(passableRegions(canvasOf(m)).sizes.length, `seed ${seed} single region`).toBe(1);
      expect((m.zones ?? []).some((z) => z.name === 'cavern')).toBe(true);
      expect(m.anchors.entrance).toBeDefined();
      expect(m.anchors.vault).toBeDefined();
    }
  });

  it('the hub-spoke cave still composes connected', () => {
    const m = composeCave({ width: 36, height: 24, seed: 2, variant: 'hub_spoke' });
    expect(passableRegions(canvasOf(m)).sizes.length).toBe(1);
  });
});
