import { mod } from './Dice.js';
import { PlayerDef, PlayerAttack, EquipmentSlots, ItemDef, ArmorDef, ShieldDef, WeaponDef, FeatDef, SpeciesDef } from './types.js';

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
  const isRanged = !!weapon.rangeNormal && weapon.rangeNormal > 0;
  return {
    name: weapon.name,
    statKey,
    damageDice: weapon.damageDice,
    damageSides: weapon.damageSides,
    damageType: weapon.damageType,
    savageAttacker: playerDef.savageAttacker,
    graze: weapon.mastery === 'graze',
    vex: weapon.mastery === 'vex',
    sap: weapon.mastery === 'sap',
    slow: weapon.mastery === 'slow',
    rangeNormal: isRanged ? weapon.rangeNormal : undefined,
    rangeLong:   isRanged ? weapon.rangeLong : undefined,
    ammunitionType: isRanged ? weapon.ammunitionType : undefined,
    loading: isRanged ? !!weapon.loading : undefined,
    heavy:   isRanged ? !!weapon.heavy : undefined,
  };
}

export function computeEquippedSlotLabels(
  playerDef: PlayerDef,
  slots: EquipmentSlots,
  allItems: ItemDef[],
): { armor: string | null; weapon: string | null; shield: string | null } {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor  = slots.armorId  ? (byId[slots.armorId]  as ArmorDef  | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  let armorLabel: string | null = null;
  if (armor) {
    const dexMod = mod(playerDef.dex);
    const dexBonus = armor.addDex ? (armor.maxDex !== null ? Math.min(dexMod, armor.maxDex) : dexMod) : 0;
    const ac = armor.baseAc + dexBonus + (playerDef.fightingStyleDefense ? 1 : 0);
    const catLabel = armor.category.charAt(0).toUpperCase() + armor.category.slice(1);
    armorLabel = `${catLabel} · AC ${ac}`;
  }

  const shieldLabel: string | null = shield ? `+${shield.acBonus} AC` : null;

  let weaponLabel: string | null = null;
  if (weapon) {
    const attack = makePlayerAttack(playerDef, weapon);
    const statMod = mod(playerDef[attack.statKey]);
    const diceStr = `${attack.damageDice}d${attack.damageSides}`;
    const sign = statMod >= 0 ? '+' : '';
    const masteries: string[] = [];
    if (attack.graze) masteries.push('Graze');
    if (attack.vex) masteries.push('Vex');
    const masteryStr = masteries.length ? ` (${masteries.join(', ')})` : '';
    weaponLabel = `${diceStr}${sign}${statMod}${masteryStr}`;
  }

  return { armor: armorLabel, weapon: weaponLabel, shield: shieldLabel };
}

export function applySpecies(playerDef: PlayerDef, allSpecies: SpeciesDef[]): void {
  const species = allSpecies.find((s) => s.id === playerDef.speciesId);
  if (!species) return;
  let speed = species.speed;
  if (playerDef.speciesLineage) {
    for (const trait of species.traits) {
      const lineage = trait.effects.lineageChoice;
      if (!lineage) continue;
      const match = lineage.options.find((o) => o.id === playerDef.speciesLineage);
      if (match?.level1?.speedBonus) speed += match.level1.speedBonus as number;
    }
  }
  playerDef.speed = speed;
}

export function applyFeats(playerDef: PlayerDef, allFeats: FeatDef[]): void {
  const byId = Object.fromEntries(allFeats.map((f) => [f.id, f]));
  playerDef.savageAttacker = false;
  playerDef.fightingStyleDefense = false;
  for (const id of playerDef.featIds) {
    const feat = byId[id];
    if (!feat) continue;
    if (feat.effects.savageAttacker) playerDef.savageAttacker = true;
    if (feat.effects.armorAcBonus) playerDef.fightingStyleDefense = true;
  }
}

export function applyEquipment(playerDef: PlayerDef, slots: EquipmentSlots, allItems: ItemDef[]): void {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor = slots.armorId ? (byId[slots.armorId] as ArmorDef | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  playerDef.ac = computeAC(playerDef, armor, shield);
  playerDef.mainAttack = weapon
    ? makePlayerAttack(playerDef, weapon)
    : { name: 'Unarmed Strike', statKey: 'str', damageDice: 1, damageSides: 1, damageType: 'bludgeoning', savageAttacker: false, graze: false, vex: false, sap: false, slow: false };
}
