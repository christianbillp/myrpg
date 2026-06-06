/**
 * US-111 — weapon/armor property enforcement.
 *
 * Versatile (two-handed damage die), Reach (PlayerAttack flag → 2-tile reach),
 * Heavy (carried for melee too), and the armor Strength-requirement speed
 * penalty + Stealth-disadvantage resolution.
 */
import { describe, it, expect } from 'vitest';
import { makePlayerAttack, armorSpeedPenaltyFt } from './EquipmentSystem.js';
import { playerAttackReachTiles, playerArmorSpeedPenaltyFt, playerHasStealthDisadvantage } from './ActionGuards.js';
import { buildTestContext, makeNpc } from '../test/buildTestContext.js';
import type { PlayerDef, WeaponDef, ArmorDef } from './types.js';

function weapon(extra: Partial<WeaponDef>): WeaponDef {
  return {
    id: 'w', name: 'W', type: 'weapon', statKey: 'str',
    damageDice: 1, damageSides: 8, damageType: 'slashing', mastery: null,
    finesse: false, twoHanded: false, thrown: false, throwNormal: 0, throwLong: 0,
    ...extra,
  } as WeaponDef;
}

const PD = { str: 14, dex: 10, savageAttacker: false } as unknown as PlayerDef;

describe('Versatile (US-111)', () => {
  const longsword = weapon({ damageDice: 1, damageSides: 8, versatile: { damageDice: 1, damageSides: 10 } });

  it('uses the larger die with a two-handed grip', () => {
    const a = makePlayerAttack(PD, longsword, true);
    expect([a.damageDice, a.damageSides]).toEqual([1, 10]);
  });

  it('uses the base die one-handed (shield equipped)', () => {
    const a = makePlayerAttack(PD, longsword, false);
    expect([a.damageDice, a.damageSides]).toEqual([1, 8]);
  });

  it('a non-versatile weapon ignores the grip', () => {
    const a = makePlayerAttack(PD, weapon({ damageSides: 6 }), true);
    expect(a.damageSides).toBe(6);
  });
});

describe('Reach & Heavy flags (US-111)', () => {
  it('marks a reach melee weapon and widens reach to 2 tiles', () => {
    const glaive = weapon({ reach: true });
    expect(makePlayerAttack(PD, glaive).reach).toBe(true);
    const { ctx } = buildTestContext({ playerDef: { mainAttack: makePlayerAttack(PD, glaive) } });
    expect(playerAttackReachTiles(ctx)).toBe(2);
  });

  it('a normal melee weapon reaches 1 tile', () => {
    const { ctx } = buildTestContext({ playerDef: { mainAttack: makePlayerAttack(PD, weapon({})) } });
    expect(playerAttackReachTiles(ctx)).toBe(1);
  });

  it('carries the Heavy flag for melee weapons', () => {
    expect(makePlayerAttack(PD, weapon({ heavy: true })).heavy).toBe(true);
  });
});

describe('Armor Strength requirement (US-111)', () => {
  it('penalises speed by 10 ft when STR is below minStr', () => {
    expect(armorSpeedPenaltyFt({ minStr: 13 } as ArmorDef, 10)).toBe(10);
  });
  it('no penalty when STR meets the requirement, or unarmored', () => {
    expect(armorSpeedPenaltyFt({ minStr: 13 } as ArmorDef, 13)).toBe(0);
    expect(armorSpeedPenaltyFt({ minStr: null } as ArmorDef, 8)).toBe(0);
    expect(armorSpeedPenaltyFt(null, 8)).toBe(0);
  });

  it('resolves the equipped armor via ctx', () => {
    const heavy = { id: 'chain', name: 'Chain', type: 'armor', category: 'heavy', baseAc: 16, addDex: false, maxDex: null, minStr: 13, stealthDisadv: true } as ArmorDef;
    const { ctx } = buildTestContext({
      player: { equippedSlots: { armorId: 'chain', weaponId: null, shieldId: null } },
      playerDef: { str: 10 },
      // equipment resolves via ctx.defs.equipment
    });
    ctx.defs.equipment.push(heavy);
    expect(playerArmorSpeedPenaltyFt(ctx)).toBe(10);
    expect(playerHasStealthDisadvantage(ctx)).toBe(true);
  });
});
