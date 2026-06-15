/**
 * Environmental hazards (#32) — register, per-round damage, spreading, scoping.
 */
import { describe, it, expect } from 'vitest';
import { registerHazardZone, tickHazardZones } from './HazardSystem.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 40, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 0,
    stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

describe('hazards (#32)', () => {
  it('registerHazardZone drops a tinted, damaging zone', () => {
    const { ctx, state } = buildTestContext({});
    const z = registerHazardZone(ctx, { x: 5, y: 5, name: 'Fire', dice: 2, sides: 6, damageType: 'fire', spreads: true });
    expect(state.activeZones).toHaveLength(1);
    expect(z.hazard?.damageType).toBe('fire');
    expect(z.tiles).toContainEqual([5, 5]);
    expect(z.tintHex).toBeTruthy();
  });

  it('damages creatures standing in it; spares those outside', () => {
    const { ctx, state, events } = buildTestContext({
      player: { tileX: 5, tileY: 5, hp: 30 },
      monsters: [dummy()],
      npcs: [
        makeNpc({ id: 'in', defId: 'dummy', tileX: 5, tileY: 5, disposition: 'enemy', hp: 40, maxHp: 40 }),
        makeNpc({ id: 'out', defId: 'dummy', tileX: 9, tileY: 9, disposition: 'enemy', hp: 40, maxHp: 40 }),
      ],
    });
    registerHazardZone(ctx, { x: 5, y: 5, dice: 3, sides: 6, damageType: 'fire' });
    tickHazardZones(ctx, events);
    expect(state.npcs.find((n) => n.id === 'in')!.hp).toBeLessThan(40);  // burned
    expect(state.npcs.find((n) => n.id === 'out')!.hp).toBe(40);          // safe
    expect(state.player.hp).toBeLessThan(30);                             // player burned too
  });

  it('a spreading hazard grows each tick', () => {
    const { ctx, events } = buildTestContext({});
    const z = registerHazardZone(ctx, { x: 5, y: 5, dice: 1, sides: 4, damageType: 'fire', spreads: true });
    const before = z.tiles.length;
    tickHazardZones(ctx, events);
    expect(z.tiles.length).toBeGreaterThan(before);
  });

  it('a non-spreading hazard does not grow', () => {
    const { ctx, events } = buildTestContext({});
    const z = registerHazardZone(ctx, { x: 5, y: 5, dice: 1, sides: 4, damageType: 'acid' });
    const before = z.tiles.length;
    tickHazardZones(ctx, events);
    expect(z.tiles.length).toBe(before);
  });
});
