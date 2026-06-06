import { mod } from './Dice.js';
import { PlayerDef, PlayerAttack, EquipmentSlots, ItemDef, ArmorDef, ShieldDef, WeaponDef, SpeciesDef } from './types.js';

export function computeAC(
  playerDef: PlayerDef,
  armor: ArmorDef | null,
  shield: ShieldDef | null,
  mageArmor = false,
  shieldSpellActive = false,
): number {
  const dexMod = mod(playerDef.dex);
  let ac: number;
  if (!armor) {
    // Mage Armor: base AC becomes 13 + DEX while no armor is worn.
    ac = (mageArmor ? 13 : 10) + dexMod;
  } else {
    const dexBonus = armor.addDex
      ? (armor.maxDex !== null ? Math.min(dexMod, armor.maxDex) : dexMod)
      : 0;
    ac = armor.baseAc + dexBonus;
    if (playerDef.fightingStyleDefense) ac += 1;
  }
  if (shield) ac += shield.acBonus;
  // SRD Shield reaction: +5 AC until the start of the caster's next turn,
  // including against the triggering attack roll. Stacks on top of armor /
  // mundane shield / Mage Armor.
  if (shieldSpellActive) ac += 5;
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
    finesse: !!weapon.finesse,
    graze: weapon.mastery === 'graze',
    vex: weapon.mastery === 'vex',
    sap: weapon.mastery === 'sap',
    slow: weapon.mastery === 'slow',
    push: weapon.mastery === 'push',
    topple: weapon.mastery === 'topple',
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

  // Seed SRD special senses from species traits — Dwarf/Elf darkvision,
  // future blindsight/tremorsense from feats/items, etc. `Vision.canSee`
  // reads `playerDef.senses` for the sight-mode resolution.
  const senses: { darkvision?: number; blindsight?: number; tremorsense?: number; truesight?: number } = {};
  for (const trait of species.traits) {
    const dv = (trait.effects as { darkvision?: { feet?: number } }).darkvision?.feet;
    if (typeof dv === 'number') senses.darkvision = Math.max(senses.darkvision ?? 0, dv);
    // Stonecunning grants Tremorsense as an activated ability with a duration
    // — the static species record always-on representation only marks the
    // creature as POTENTIALLY having it. We leave the activated form out of
    // the static `playerDef.senses` block for now.
  }
  if (Object.keys(senses).length > 0) playerDef.senses = senses;
}

export function applyEquipment(
  playerDef: PlayerDef,
  slots: EquipmentSlots,
  allItems: ItemDef[],
  mageArmor = false,
  shieldSpellActive = false,
  magicWeaponBonus = 0,
): void {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor = slots.armorId ? (byId[slots.armorId] as ArmorDef | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  playerDef.ac = computeAC(playerDef, armor, shield, mageArmor, shieldSpellActive);
  const base = weapon
    ? makePlayerAttack(playerDef, weapon)
    : { name: 'Unarmed Strike', statKey: 'str' as const, damageDice: 1, damageSides: 1, damageType: 'bludgeoning', savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false };
  // SRD Magic Weapon spell: +N to attack and damage rolls. The bonus rides
  // on the PlayerAttack so the existing CombatSystem resolver consumes it
  // without a separate state lookup; reset to 0 when the spell ends.
  playerDef.mainAttack = magicWeaponBonus > 0
    ? { ...base, magicWeaponBonus }
    : base;
}
