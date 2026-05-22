import { mod } from './Dice';
import { PlayerDef, PlayerAttack, EquipmentSlots } from '../data/player';
import { ItemDef, ArmorDef, ShieldDef, WeaponDef } from '../data/items';

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
  if (weapon.finesse) {
    statKey = mod(playerDef.dex) >= mod(playerDef.str) ? 'dex' : 'str';
  }
  return {
    name: weapon.name,
    statKey,
    damageDice: weapon.damageDice,
    damageSides: weapon.damageSides,
    savageAttacker: playerDef.savageAttacker,
    graze: weapon.mastery === 'graze',
    vex: weapon.mastery === 'vex',
  };
}

export function applyEquipment(
  playerDef: PlayerDef,
  slots: EquipmentSlots,
  allItems: ItemDef[],
): void {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor = slots.armorId ? (byId[slots.armorId] as ArmorDef | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  playerDef.ac = computeAC(playerDef, armor, shield);

  if (weapon) {
    playerDef.mainAttack = makePlayerAttack(playerDef, weapon);
  } else {
    playerDef.mainAttack = {
      name: 'Unarmed Strike',
      statKey: 'str',
      damageDice: 1,
      damageSides: 1,
      savageAttacker: false,
      graze: false,
      vex: false,
    };
  }
}

export function resolveItem<T extends ItemDef>(id: string, allItems: ItemDef[]): T | null {
  return (allItems.find((i) => i.id === id) as T | undefined) ?? null;
}

export function attackSummary(attack: PlayerAttack, statMod: number): string {
  const diceStr = `${attack.damageDice}d${attack.damageSides}`;
  const sign = statMod >= 0 ? '+' : '';
  const masteries: string[] = [];
  if (attack.graze) masteries.push('Graze');
  if (attack.vex) masteries.push('Vex');
  const masteryStr = masteries.length ? ` (${masteries.join(', ')})` : '';
  return `${diceStr}${sign}${statMod}${masteryStr}`;
}
