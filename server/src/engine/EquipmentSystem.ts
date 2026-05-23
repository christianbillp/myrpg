import { mod } from './Dice.js';
import { PlayerDef, PlayerAttack, EquipmentSlots, ItemDef, ArmorDef, ShieldDef, WeaponDef } from './types.js';

export function computeAC(
  playerDef: PlayerDef,
  armor: ArmorDef | null,
  shield: ShieldDef | null,
): number {
  const dexMod = mod(playerDef.dex);
  let ac: number;
  if (!armor) {
    ac = 10 + dexMod;
  } else {
    const dexBonus = armor.addDex
      ? (armor.maxDex !== null ? Math.min(dexMod, armor.maxDex) : dexMod)
      : 0;
    ac = armor.baseAc + dexBonus;
    if (playerDef.fightingStyleDefense) ac += 1;
  }
  if (shield) ac += shield.acBonus;
  return ac;
}

export function makePlayerAttack(playerDef: PlayerDef, weapon: WeaponDef): PlayerAttack {
  let statKey: 'str' | 'dex' = weapon.statKey;
  if (weapon.finesse) statKey = mod(playerDef.dex) >= mod(playerDef.str) ? 'dex' : 'str';
  return {
    name: weapon.name,
    statKey,
    damageDice: weapon.damageDice,
    damageSides: weapon.damageSides,
    damageType: weapon.damageType,
    savageAttacker: playerDef.savageAttacker,
    graze: weapon.mastery === 'graze',
    vex: weapon.mastery === 'vex',
  };
}

export function applyEquipment(playerDef: PlayerDef, slots: EquipmentSlots, allItems: ItemDef[]): void {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor = slots.armorId ? (byId[slots.armorId] as ArmorDef | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  playerDef.ac = computeAC(playerDef, armor, shield);
  playerDef.mainAttack = weapon
    ? makePlayerAttack(playerDef, weapon)
    : { name: 'Unarmed Strike', statKey: 'str', damageDice: 1, damageSides: 1, damageType: 'bludgeoning', savageAttacker: false, graze: false, vex: false };
}
