/**
 * US-119 — Extra Attack (player).
 *
 * A character whose `extra-attacks` track is >1 may make that many weapon
 * attacks per Attack action. The first attack commits the Action and reserves
 * the rest on `player.attacksRemaining`; each follow-up draws the reserve down
 * without spending another Action. When the reserve is empty the Action is
 * fully spent and ATTACK is no longer available. (Every attack — hit or miss —
 * advances the reserve, so this is deterministic without looping for a hit.)
 */
import { describe, it, expect } from 'vitest';
import { doAttack } from './CombatActions.js';
import { canAttackTarget } from './ActionGuards.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const SWORD: PlayerAttack = {
  name: 'Sword', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
};

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 80, ac: 5,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function scenario(extraAttacks: number) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 0, tileY: 0 },
    playerDef: { mainAttack: SWORD, str: 16, proficiencyBonus: 3, tracks: { 'extra-attacks': extraAttacks } },
    monsters: [dummy()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 80, maxHp: 80 })],
  });
  r.state.environment = { lightLevel: 'bright' };
  r.state.traps = [];
  r.state.selectedTargetId = 'enemy_x';
  return r;
}

describe('Extra Attack (US-119)', () => {
  it('a 2-attack character makes two attacks per Action', () => {
    const { ctx, state, events } = scenario(2);
    doAttack(ctx, 'enemy_x', events);
    expect(state.player.actionUsed).toBe(true);        // Action committed on the first attack
    expect(state.player.attacksRemaining).toBe(1);     // one follow-up reserved
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(true); // follow-up allowed despite actionUsed

    doAttack(ctx, 'enemy_x', events);
    expect(state.player.attacksRemaining).toBe(0);      // reserve spent
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(false); // Action gone, no reserve left
  });

  it('a 3-attack character makes three attacks per Action', () => {
    const { ctx, state, events } = scenario(3);
    doAttack(ctx, 'enemy_x', events);
    expect(state.player.attacksRemaining).toBe(2);
    doAttack(ctx, 'enemy_x', events);
    expect(state.player.attacksRemaining).toBe(1);
    doAttack(ctx, 'enemy_x', events);
    expect(state.player.attacksRemaining).toBe(0);
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(false);
  });

  it('a single-attack character spends the Action on one attack', () => {
    const { ctx, state, events } = scenario(1);
    doAttack(ctx, 'enemy_x', events);
    expect(state.player.actionUsed).toBe(true);
    expect(state.player.attacksRemaining).toBe(0);
    expect(canAttackTarget(ctx, 'enemy_x')).toBe(false);
  });
});
