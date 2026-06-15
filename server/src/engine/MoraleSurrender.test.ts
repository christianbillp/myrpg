/**
 * Encounter engagement #34 — Morale: enemies surrender.
 *
 * The flee half of morale already exists (`chooseNpcBehavior` → `fleeFromThreat`).
 * These cover the new yield path: a bloodied, last-standing, thinking creature
 * that can't escape (or is badly hurt) throws down its arms instead of dying —
 * flipping to a neutral non-combatant marked `surrendered`, which ends combat if
 * no hostiles remain. Mindless types (undead, beasts) never yield.
 */
import { describe, it, expect } from 'vitest';
import { npcCanYield, npcWouldYield, applyNpcSurrender } from './NpcTurnRunners.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef } from './types.js';

function def(type: string): MonsterDef {
  return {
    id: 'm', name: 'M', type, maxHp: 10, ac: 12,
    str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 10, proficiencyBonus: 2, initiativeBonus: 1,
    stealthBonus: 0, passivePerception: 10, speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0x999, tokenAsset: 'm.svg', size: 'medium',
  } as MonsterDef;
}

function bandit(hp: number) {
  return makeNpc({ id: 'enemy_x', defId: 'm', tileX: 5, tileY: 5, disposition: 'enemy', hp, maxHp: 10 });
}

describe('morale — surrender (#34)', () => {
  it('only thinking creatures can yield', () => {
    expect(npcCanYield(bandit(3), def('Medium Humanoid'))).toBe(true);
    expect(npcCanYield(bandit(3), def('Large Giant'))).toBe(true);
    expect(npcCanYield(bandit(3), def('Medium Undead'))).toBe(false);
    expect(npcCanYield(bandit(3), def('Large Beast'))).toBe(false);
  });

  it('a bloodied, last-standing humanoid yields (no more hopeless solo fights)', () => {
    const { ctx, state } = buildTestContext({ npcs: [bandit(4)] }); // 4/10 = bloodied
    expect(npcWouldYield(ctx, state.npcs[0], def('Medium Humanoid'))).toBe(true);
  });

  it('does NOT yield while another enemy still fights', () => {
    const { ctx, state } = buildTestContext({
      npcs: [bandit(3), makeNpc({ id: 'enemy_y', defId: 'm', tileX: 6, tileY: 5, disposition: 'enemy', hp: 10, maxHp: 10 })],
    });
    expect(npcWouldYield(ctx, state.npcs[0], def('Medium Humanoid'))).toBe(false);
  });

  it('does NOT yield while unbloodied (strong last foes fight on)', () => {
    const { ctx, state } = buildTestContext({ npcs: [bandit(9)] }); // 9/10 — not bloodied
    expect(npcWouldYield(ctx, state.npcs[0], def('Medium Humanoid'))).toBe(false);
  });

  it('a mindless last-standing foe (undead) never yields, even bloodied', () => {
    const { ctx, state } = buildTestContext({ npcs: [bandit(2)] });
    expect(npcWouldYield(ctx, state.npcs[0], def('Medium Undead'))).toBe(false);
  });

  it('applying surrender flips to a neutral, passive, marked non-combatant', () => {
    const { ctx, state, events } = buildTestContext({ npcs: [bandit(3)] });
    const npc = state.npcs[0];
    applyNpcSurrender(ctx, npc, events);
    expect(npc.disposition).toBe('neutral');
    expect(npc.combatPassive).toBe(true);
    expect(npc.conditions).toContain('surrendered');
    // No longer yields a second time.
    expect(npcCanYield(npc, def('Medium Humanoid'))).toBe(false);
  });
});
