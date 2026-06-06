/**
 * US-124 (Phase 9) Slice 1 — magic weapon / armor / shield enhancement bonuses.
 *
 * A `bonus` on a weapon adds to attack & damage (via the shared
 * `magicWeaponBonus` path, not stacking with the Magic Weapon spell); on armor
 * / shields it adds to AC. Per SRD these +N items don't require attunement, so
 * the bonus applies whenever equipped.
 */
import { describe, it, expect } from 'vitest';
import { computeAC, makePlayerAttack, applyEquipment } from './EquipmentSystem.js';
import type { PlayerDef, ArmorDef, ShieldDef, WeaponDef, ItemDef } from './types.js';

const PD = { str: 14, dex: 12, fightingStyleDefense: false, savageAttacker: false } as unknown as PlayerDef;

function weapon(extra: Partial<WeaponDef>): WeaponDef {
  return {
    id: 'w', name: 'W', type: 'weapon', statKey: 'str',
    damageDice: 1, damageSides: 8, damageType: 'slashing', mastery: null,
    finesse: false, twoHanded: false, thrown: false, throwNormal: 0, throwLong: 0,
    ...extra,
  } as WeaponDef;
}

describe('Magic armor / shield AC bonus (US-124)', () => {
  const leather: ArmorDef = { id: 'l', name: 'L', type: 'armor', category: 'light', baseAc: 11, addDex: true, maxDex: null };

  it('adds the armor bonus to AC', () => {
    const plain = computeAC(PD, leather, null);
    const magic = computeAC(PD, { ...leather, bonus: 1 }, null);
    expect(magic).toBe(plain + 1);
  });

  it('adds the shield bonus on top of its acBonus', () => {
    const shield: ShieldDef = { id: 's', name: 'S', type: 'shield', acBonus: 2, bonus: 1 };
    expect(computeAC(PD, null, shield)).toBe(computeAC(PD, null, null) + 3);  // +2 shield +1 magic
  });
});

describe('Magic weapon bonus (US-124)', () => {
  it('routes the weapon bonus through magicWeaponBonus (attack + damage)', () => {
    const items: ItemDef[] = [weapon({ id: 'sword1', bonus: 1 })];
    const pd = { ...PD } as PlayerDef;
    applyEquipment(pd, { armorId: null, weaponId: 'sword1', shieldId: null }, items);
    expect(pd.mainAttack.magicWeaponBonus).toBe(1);
  });

  it('does not stack with the Magic Weapon spell — takes the higher', () => {
    const items: ItemDef[] = [weapon({ id: 'sword1', bonus: 1 })];
    const pd = { ...PD } as PlayerDef;
    // Magic Weapon spell grants +2 via the magicWeaponBonus argument.
    applyEquipment(pd, { armorId: null, weaponId: 'sword1', shieldId: null }, items, false, false, 2);
    expect(pd.mainAttack.magicWeaponBonus).toBe(2);  // max(1 item, 2 spell)
  });

  it('a mundane weapon carries no bonus', () => {
    const items: ItemDef[] = [weapon({ id: 'sword0' })];
    const pd = { ...PD } as PlayerDef;
    applyEquipment(pd, { armorId: null, weaponId: 'sword0', shieldId: null }, items);
    expect(pd.mainAttack.magicWeaponBonus).toBeUndefined();
  });
});
