/**
 * US-052 — Knocking Out a Creature.
 *
 * With KNOCK OUT mode on, a melee blow that drops an enemy to 0 HP routes to
 * `knockOutNpc` (Unconscious + Stable) instead of `killWithReward`. The test
 * ctx's `knockOutNpc` stub tags the target Unconscious, so the branch is
 * observable. (Attacks can miss on a natural 1, so we retry fresh scenarios
 * until a hit lands — deterministic once it does.)
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
    id: 'goblin', name: 'Goblin', type: 'Small Humanoid', maxHp: 1, ac: 1,
    str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 0, passivePerception: 9,
    speed: 30, attacks: [], xp: 50, cr: '1/4', color: 0x884400, tokenAsset: 'x.svg', size: 'small',
  } as MonsterDef;
}

function scenario(nonLethal: boolean) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0, nonLethal },
    playerDef: { mainAttack: SWORD, str: 14, proficiencyBonus: 2 },
    monsters: [goblin()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'goblin', tileX: 1, tileY: 0, disposition: 'enemy', hp: 1, maxHp: 1, size: 'small' })],
  });
  r.state.environment = { lightLevel: 'bright' };
  r.state.traps = [];
  return r;
}

/** Attack until the enemy drops; return its conditions at that point. */
function attackUntilDown(nonLethal: boolean): string[] {
  for (let i = 0; i < 60; i++) {
    const { ctx, state, events } = scenario(nonLethal);
    doAttack(ctx, 'enemy_x', events);
    if (state.npcs[0].hp <= 0) return state.npcs[0].conditions;
  }
  throw new Error('attack never landed in 60 tries');
}

describe('Knock-out (US-052)', () => {
  it('leaves a melee-killed enemy Unconscious when KNOCK OUT is on', () => {
    expect(attackUntilDown(true)).toContain('unconscious');
  });

  it('kills normally (no Unconscious) when KNOCK OUT is off', () => {
    expect(attackUntilDown(false)).not.toContain('unconscious');
  });
});
