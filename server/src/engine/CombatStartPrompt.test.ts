/**
 * Combat-start confirmation.
 *
 * An attack (or aggressive cast) made in the exploring phase WOULD start
 * combat. Instead of acting immediately, the engine surfaces
 * `state.pendingCombatStart` and waits. Declining discards the action (nothing
 * happens); accepting rolls initiative WITHOUT performing the original action —
 * the player then acts normally on their turn.
 */
import { describe, it, expect } from 'vitest';
import { doAttack } from './CombatActions.js';
import { doResolveCombatStart } from './CombatStartPrompt.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { MonsterDef, PlayerAttack } from './types.js';

const SWORD: PlayerAttack = {
  name: 'Sword', statKey: 'str', damageDice: 1, damageSides: 8, damageType: 'slashing',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
};

function dummy(): MonsterDef {
  return {
    id: 'dummy', name: 'Dummy', type: 'Medium Humanoid', maxHp: 30, ac: 12,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [], xp: 0, cr: '1', color: 0x888888, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

function scenario() {
  const r = buildTestContext({
    phase: 'exploring',
    player: { tileX: 0, tileY: 0 },
    playerDef: { mainAttack: SWORD, str: 16, proficiencyBonus: 3 },
    monsters: [dummy()],
    npcs: [makeNpc({ id: 'enemy_x', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'neutral', hp: 30, maxHp: 30 })],
  });
  r.state.environment = { lightLevel: 'bright' };
  r.state.traps = [];
  r.state.selectedTargetId = 'enemy_x';
  return r;
}

describe('Combat-start confirmation', () => {
  it('attacking a neutral in exploring pauses on pendingCombatStart instead of acting', () => {
    const { ctx, state, events } = scenario();
    doAttack(ctx, 'enemy_x', events);
    expect(state.pendingCombatStart).not.toBeNull();
    expect(state.pendingCombatStart!.promoteIds).toEqual(['enemy_x']);
    expect(state.phase).toBe('exploring');           // combat NOT started yet
    expect(state.npcs[0].disposition).toBe('neutral'); // not promoted yet
    expect(state.npcs[0].hp).toBe(30);                 // no damage dealt
  });

  it('declining discards the action — nothing happens', () => {
    const { ctx, state, events } = scenario();
    doAttack(ctx, 'enemy_x', events);
    doResolveCombatStart(ctx, false, events);
    expect(state.pendingCombatStart).toBeNull();
    expect(state.phase).toBe('exploring');
    expect(state.npcs[0].disposition).toBe('neutral');
    expect(state.npcs[0].hp).toBe(30);
  });

  it('accepting promotes the target and starts combat without performing the attack', () => {
    const { ctx, state, events } = scenario();
    let started = 0;
    ctx.doStartCombat = () => { started++; };
    doAttack(ctx, 'enemy_x', events);
    doResolveCombatStart(ctx, true, events);
    expect(state.pendingCombatStart).toBeNull();
    expect(started).toBe(1);                          // initiative rolled
    expect(state.npcs[0].disposition).toBe('enemy');  // promoted
    expect(state.npcs[0].hp).toBe(30);                // attack NOT auto-performed
  });
});
