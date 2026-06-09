/**
 * Invisibility concealment — the SRD "find me" layer. A creature that casts
 * Invisibility forces nearby enemies to make a Wisdom (Perception) check against
 * its Dexterity (Stealth) total; those that fail cannot make a direct attack
 * roll against it. Determinism comes from extreme Stealth / Perception values
 * that force the d20 either always-fail or always-succeed.
 */
import { describe, it, expect } from 'vitest';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import { pickEnemyAttackTarget } from './NpcTurnRunners.js';
import {
  applyInvisibilityConcealment, attackerCannotLocate, clearInvisibilityConcealment,
} from './InvisibilitySystem.js';
import type { MonsterDef } from './types.js';

function goblin(overrides: Partial<MonsterDef> = {}): MonsterDef {
  return {
    id: 'goblin', name: 'Goblin', type: 'Small Humanoid', maxHp: 12, ac: 13,
    str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8,
    proficiencyBonus: 2, initiativeBonus: 2, stealthBonus: 0, passivePerception: 9,
    speed: 30, attacks: [{ name: 'Scimitar', attackType: 'melee', toHit: 4, damageDice: 1, damageSides: 6, damageBonus: 2, damageType: 'slashing' }],
    xp: 50, cr: '1/4', color: 0x559955, tokenAsset: 'g.svg', size: 'small',
    ...overrides,
  } as MonsterDef;
}

function scenario(stealth: number, monster: MonsterDef = goblin()) {
  const r = buildTestContext({
    phase: 'player_turn',
    player: { tileX: 5, tileY: 5, conditions: ['invisible'] },
    playerDef: { skills: { stealth }, dex: 10 },
    monsters: [monster],
    npcs: [makeNpc({ id: 'g1', defId: monster.id, tileX: 5, tileY: 6, disposition: 'enemy', hp: 12, maxHp: 12 })],
  });
  r.state.environment = { lightLevel: 'bright' };
  return r;
}

describe('Invisibility — find checks', () => {
  it('an enemy that fails Perception loses track and cannot be given the invisible creature as a target', () => {
    const { ctx, state } = scenario(100); // find DC ≥ 101 → goblin always fails
    applyInvisibilityConcealment(ctx, 'player');
    expect(state.player.unseenBy).toEqual(['g1']);
    expect(attackerCannotLocate('g1', state.player)).toBe(true);
    // The invisible player is the only hostile, and this goblin can't find it →
    // the picker yields the non-attackable fallback.
    expect(pickEnemyAttackTarget(ctx, state.npcs[0]).noAttack).toBe(true);
  });

  it('an enemy that succeeds on Perception still sees the invisible creature', () => {
    const { ctx, state } = scenario(-100); // find DC ≤ −80 → goblin always succeeds
    applyInvisibilityConcealment(ctx, 'player');
    expect(state.player.unseenBy).toEqual([]);
    expect(attackerCannotLocate('g1', state.player)).toBe(false);
    const target = pickEnemyAttackTarget(ctx, state.npcs[0]);
    expect(target.id).toBe('player');
    expect(target.noAttack).toBeFalsy();
  });

  it('truesight pierces Invisibility — the creature is always found', () => {
    const { ctx, state } = scenario(100, goblin({ id: 'spectator', senses: { truesight: 60 } }));
    applyInvisibilityConcealment(ctx, 'player');
    expect(state.player.unseenBy).toEqual([]); // truesight enemy auto-finds, never added
    expect(pickEnemyAttackTarget(ctx, state.npcs[0]).id).toBe('player');
  });

  it('clears the find-state when Invisibility ends', () => {
    const { ctx, state } = scenario(100);
    applyInvisibilityConcealment(ctx, 'player');
    expect(state.player.unseenBy).toEqual(['g1']);
    clearInvisibilityConcealment(state);
    expect(state.player.unseenBy).toBeUndefined();
  });
});
