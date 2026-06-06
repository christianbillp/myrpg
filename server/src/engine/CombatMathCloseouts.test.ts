/**
 * US-113 — combat-math closeouts.
 *
 * Exhaustion −2 × level penalty on the player's attack roll (a D20 Test),
 * mirroring the check/save penalty. The penalty is asserted deterministically
 * via the reroll snapshot: attackTotal − naturalRoll === the attack bonus,
 * independent of the random d20.
 */
import { describe, it, expect } from 'vitest';
import { doAttack } from './CombatActions.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const SWORD: PlayerAttack = {
  name: 'Sword', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
};

function goblin(): MonsterDef {
  return {
    id: 'goblin', name: 'Goblin', type: 'Small Humanoid', maxHp: 100, ac: 1,
    str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 0, passivePerception: 9,
    speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0x884400, tokenAsset: 'x.svg',
  } as MonsterDef;
}

/** Attack via the Heroic-Inspiration pause so the rolled snapshot is exposed
 *  on pendingReroll; returns the derived attack bonus (total − natural). */
function attackBonusWithExhaustion(level: number): number {
  const { ctx, state, events } = buildTestContext({
    phase: 'player_turn',
    // str 14 (+2 mod), proficiencyBonus 2 → base attack bonus +4.
    player: { tileX: 0, tileY: 0, heroicInspiration: true, exhaustionLevel: level },
    playerDef: { mainAttack: SWORD, str: 14, proficiencyBonus: 2 },
    monsters: [goblin()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'goblin', tileX: 1, tileY: 0, disposition: 'enemy', hp: 100, maxHp: 100 })],
  });
  state.environment = { lightLevel: 'bright' };
  doAttack(ctx, 'enemy_x', events);
  const r = state.pendingReroll!.resolved;
  return r.attackTotal - r.naturalRoll;
}

describe('US-113 — Exhaustion penalty on the player attack roll', () => {
  it('applies no penalty at exhaustion 0 (base +4)', () => {
    expect(attackBonusWithExhaustion(0)).toBe(4);
  });

  it('subtracts 2 per exhaustion level', () => {
    expect(attackBonusWithExhaustion(1)).toBe(2);   // 4 − 2
    expect(attackBonusWithExhaustion(2)).toBe(0);   // 4 − 4
    expect(attackBonusWithExhaustion(3)).toBe(-2);  // 4 − 6
  });
});
