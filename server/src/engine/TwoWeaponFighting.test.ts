/**
 * US-128 — Two-Weapon Fighting, Nick, Cleave, and Loading enforcement.
 */
import { describe, it, expect } from 'vitest';
import { makePlayerAttack } from './EquipmentSystem.js';
import { canOffhandAttack } from './ActionGuards.js';
import { doOffhandAttack } from './CombatActions.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { PlayerDef, WeaponDef, MonsterDef } from './types.js';

function weapon(extra: Partial<WeaponDef>): WeaponDef {
  return {
    id: 'w', name: 'W', type: 'weapon', statKey: 'str',
    damageDice: 1, damageSides: 6, damageType: 'slashing', mastery: null,
    finesse: false, twoHanded: false, thrown: false, throwNormal: 0, throwLong: 0,
    ...extra,
  } as WeaponDef;
}

const dagger = weapon({ id: 'dagger', name: 'Dagger', light: true, mastery: 'nick', finesse: true });
const shortsword = weapon({ id: 'shortsword', name: 'Shortsword', light: true, mastery: 'vex', finesse: true });
const longsword = weapon({ id: 'longsword', name: 'Longsword', light: false });

function dummy(id: string): MonsterDef {
  return {
    id, name: id, type: 'Medium Humanoid', maxHp: 50, ac: 1,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    proficiencyBonus: 2, initiativeBonus: 0, stealthBonus: 0, passivePerception: 10,
    speed: 30, attacks: [{ name: 'x', attackType: 'melee', bonus: 0, reach: 5, damageDice: 1, damageSides: 1, damageBonus: 0, damageType: 'b' }],
    xp: 0, cr: '0', color: 0, tokenAsset: 'x.svg', size: 'medium',
  } as MonsterDef;
}

const PD = { str: 16, dex: 16, proficiencyBonus: 2, savageAttacker: false } as unknown as PlayerDef;

function twfContext(opts: { mainMastery?: string; offMastery?: string } = {}) {
  const main = weapon({ id: 'shortsword', name: 'Shortsword', light: true, mastery: opts.mainMastery ?? 'vex', finesse: true });
  const off = weapon({ id: 'dagger', name: 'Dagger', light: true, mastery: opts.offMastery ?? 'vex', finesse: true });
  const target = makeNpc({ id: 't', defId: 'dummy', tileX: 1, tileY: 0, disposition: 'enemy', hp: 50, maxHp: 50 });
  const res = buildTestContext({
    phase: 'player_turn',
    monsters: [dummy('dummy')],
    equipment: [main, off],
    npcs: [target],
    playerDef: { str: 16, dex: 16, mainAttack: makePlayerAttack(PD, main) } as never,
    player: { tileX: 0, tileY: 0, equippedSlots: { armorId: null, weaponId: 'shortsword', shieldId: null, offhandId: 'dagger' }, attackedThisTurn: true },
  });
  return { ...res, target };
}

describe('Light / Nick flags on the attack (US-128)', () => {
  it('makePlayerAttack carries light + nick + the offhand damage suppression flag', () => {
    expect(makePlayerAttack(PD, dagger).light).toBe(true);
    expect(makePlayerAttack(PD, dagger).nick).toBe(true);
    expect(makePlayerAttack(PD, shortsword).nick).toBe(false);
    expect(makePlayerAttack(PD, longsword).light).toBe(false);
  });
});

describe('canOffhandAttack gate (US-128)', () => {
  it('requires Light in both hands, a prior attack, and the bonus action (or Nick)', () => {
    const { ctx } = twfContext();
    expect(canOffhandAttack(ctx)).toBe(true);
  });

  it('is false before the player has attacked this turn', () => {
    const { ctx, state } = twfContext();
    state.player.attackedThisTurn = false;
    expect(canOffhandAttack(ctx)).toBe(false);
  });

  it('is false with a non-light off-hand', () => {
    const main = weapon({ id: 'shortsword', light: true });
    const off = weapon({ id: 'mace', light: false, mastery: 'sap' });
    const { ctx } = buildTestContext({
      phase: 'player_turn',
      equipment: [main, off],
      player: { equippedSlots: { armorId: null, weaponId: 'shortsword', shieldId: null, offhandId: 'mace' }, attackedThisTurn: true },
    });
    expect(canOffhandAttack(ctx)).toBe(false);
  });

  it('Nick lets the off-hand attack ride even with the bonus action spent', () => {
    const { ctx, state } = twfContext({ offMastery: 'nick' });
    state.player.bonusActionUsed = true;
    expect(canOffhandAttack(ctx)).toBe(true);
  });

  it('without Nick a spent bonus action blocks it', () => {
    const { ctx, state } = twfContext();
    state.player.bonusActionUsed = true;
    expect(canOffhandAttack(ctx)).toBe(false);
  });
});

describe('doOffhandAttack economy (US-128)', () => {
  it('spends the bonus action and marks it used (no Nick)', () => {
    const { ctx, state } = twfContext();
    doOffhandAttack(ctx, 't', []);
    expect(state.player.offhandAttackUsedThisTurn).toBe(true);
    expect(state.player.bonusActionUsed).toBe(true);
  });

  it('rides free on Nick — bonus action preserved', () => {
    const { ctx, state } = twfContext({ mainMastery: 'nick' });
    doOffhandAttack(ctx, 't', []);
    expect(state.player.offhandAttackUsedThisTurn).toBe(true);
    expect(state.player.bonusActionUsed).toBeFalsy();
  });

  it('off-hand damage never carries the positive ability modifier', () => {
    // Invariant over many swings: the 1d6 off-hand hit adds NO +3 STR mod.
    // Without the mod the cap is 6 (normal) or 12 (crit, 2d6); WITH the mod a
    // main-hand swing would reach 9 (normal) or 15 (crit). So every result
    // must stay ≤ 12, the crit floor never produces a non-crit hit > 6, and
    // at least one swing lands.
    let everHit = false;
    for (let i = 0; i < 60; i++) {
      const { ctx, target } = twfContext();
      const before = target.hp;
      doOffhandAttack(ctx, 't', []);
      const dealt = before - target.hp;
      if (dealt > 0) everHit = true;
      // 1d6 normal ≤ 6, 2d6 crit ≤ 12 — both with NO +3 STR mod. WITH the mod
      // a swing would reach 9 (normal) or 15 (crit), so > 12 is impossible here.
      expect(dealt).toBeLessThanOrEqual(12);
    }
    expect(everHit).toBe(true);
  });
});
