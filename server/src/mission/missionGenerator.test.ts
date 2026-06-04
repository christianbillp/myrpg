/**
 * Tests for the procedural mission generator.
 *
 * Three properties matter:
 *   1. Generator produces a complete `GeneratedMission` envelope.
 *   2. `excludeFlavour` is honoured — the same flavour never rolls
 *      twice in a row when the guard is set.
 *   3. Reward scaling is correct per the table.
 */
import { describe, it, expect } from 'vitest';
import { generateMission, pickMissionFlavour, type MissionFlavour } from './missionGenerator.js';
import type { MapTilesetInfo } from '../../../shared/types.js';

function stubTilesets(): MapTilesetInfo[] {
  return [{
    firstgid: 1,
    name: 'stub',
    imageUrl: '/tilesets/stub.png',
    imagewidth: 64, imageheight: 64,
    tilewidth: 16,  tileheight: 16,
    spacing: 0, margin: 0,
    columns: 4,
    tilePassability: {},
  }];
}

describe('generateMission', () => {
  it('returns a complete envelope with map, encounter def, and reward', () => {
    const m = generateMission({ tilesets: stubTilesets(), disabledScribble: new Set() });
    expect(m.missionId).toMatch(/^mission_gen_/);
    expect(['bandit', 'goblin', 'skeleton']).toContain(m.flavour);
    expect([1, 2]).toContain(m.enemyCount);
    expect(m.encounterDef.id).toBe(m.missionId);
    expect(m.encounterDef.mapId).toBe(m.missionId);
    expect(m.encounterDef.placements?.length).toBe(1 + m.enemyCount);
    expect(m.savedMap.id).toBe(m.missionId);
    expect(m.savedMap.gidGrid.length).toBe(m.savedMap.rows);
    expect(m.savedMap.gidGrid[0].length).toBe(m.savedMap.cols);
    expect(m.reward.cpDelta).toBeGreaterThan(0);
    expect(m.reward.xp).toBeGreaterThan(0);
  });

  it('honours excludeFlavour — never rolls the excluded flavour', () => {
    for (let i = 0; i < 20; i++) {
      const m = generateMission({
        tilesets: stubTilesets(),
        disabledScribble: new Set(),
        excludeFlavour: 'bandit',
      });
      expect(m.flavour).not.toBe('bandit');
    }
  });

  it('scales reward by count', () => {
    const one = generateMission({
      tilesets: stubTilesets(),
      disabledScribble: new Set(),
      flavour: 'bandit', count: 1,
    });
    const two = generateMission({
      tilesets: stubTilesets(),
      disabledScribble: new Set(),
      flavour: 'bandit', count: 2,
    });
    // Two-enemy reward = 2x base + same completion bonus.
    expect(two.reward.cpDelta - one.reward.cpDelta).toBe(1000); // one extra bandit's cp
    expect(two.reward.xp - one.reward.xp).toBe(50);             // one extra bandit's xp
  });

  it('placements put player at west, enemies at east', () => {
    const m = generateMission({
      tilesets: stubTilesets(),
      disabledScribble: new Set(),
      flavour: 'bandit', count: 2,
    });
    const player = m.encounterDef.placements?.find((p) => p.role === 'player');
    const enemies = m.encounterDef.placements?.filter((p) => p.role === 'enemy') ?? [];
    expect(player?.x).toBeLessThan(enemies[0].x);
    expect(enemies.length).toBe(2);
  });

  it('generates triggers for intro, done, and done-aigm', () => {
    const m = generateMission({ tilesets: stubTilesets(), disabledScribble: new Set() });
    const triggerIds = ((m.encounterDef.triggers ?? []) as Array<{ id: string }>).map((t) => t.id);
    expect(triggerIds).toEqual(['mission_intro', 'mission_done', 'mission_done_aigm']);
  });
});

describe('pickMissionFlavour', () => {
  it('distributes across all three flavours', () => {
    const seen = new Set<MissionFlavour>();
    for (let i = 0; i < 100; i++) seen.add(pickMissionFlavour());
    expect(seen.size).toBe(3);
  });
});
