import { mod } from './Dice.js';
import { PlayerDef, PlayerAttack, EquipmentSlots, ItemDef, ArmorDef, ShieldDef, WeaponDef, SpeciesDef, parseCreatureSize, sizeRank, CreatureSize, Modifier } from './types.js';

/** A magic item's effective enhancement bonus (US-124): its `bonus`, gated to 0
 *  when the item requires attunement and the player isn't attuned to it. */
export function effectiveItemBonus(
  item: { id: string; bonus?: number; requiresAttunement?: boolean } | null,
  attunedItemIds: string[],
): number {
  if (!item) return 0;
  if (item.requiresAttunement && !attunedItemIds.includes(item.id)) return 0;
  return item.bonus ?? 0;
}

export function computeAC(
  playerDef: PlayerDef,
  armor: ArmorDef | null,
  shield: ShieldDef | null,
  mageArmor = false,
  shieldSpellActive = false,
  attunedItemIds: string[] = [],
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
    ac = armor.baseAc + dexBonus + effectiveItemBonus(armor, attunedItemIds);  // US-124 magic armor +N
    if (playerDef.fightingStyleDefense) ac += 1;
  }
  if (shield) ac += shield.acBonus + effectiveItemBonus(shield, attunedItemIds);  // US-124 magic shield +N
  // SRD Shield reaction: +5 AC until the start of the caster's next turn,
  // including against the triggering attack roll. Stacks on top of armor /
  // mundane shield / Mage Armor.
  if (shieldSpellActive) ac += 5;
  return ac;
}

/**
 * SRD armor Strength requirement (US-111): wearing armor whose `minStr` exceeds
 * your Strength score reduces your speed by 10 ft. Returns the penalty in feet
 * (0 or 10). `null` armor (unarmored) is never penalised.
 */
export function armorSpeedPenaltyFt(armor: ArmorDef | null, str: number): number {
  return armor && armor.minStr != null && str < armor.minStr ? 10 : 0;
}

export function makePlayerAttack(playerDef: PlayerDef, weapon: WeaponDef, twoHandedGrip = false): PlayerAttack {
  let statKey: 'str' | 'dex' = weapon.statKey;
  if (weapon.finesse) statKey = mod(playerDef.dex) >= mod(playerDef.str) ? 'dex' : 'str';
  const isRanged = !!weapon.rangeNormal && weapon.rangeNormal > 0;
  // SRD Versatile (US-111): a versatile weapon wielded two-handed (no shield)
  // uses its larger damage die.
  const useVersatile = !!weapon.versatile && twoHandedGrip;
  return {
    name: weapon.name,
    statKey,
    damageDice: useVersatile ? weapon.versatile!.damageDice : weapon.damageDice,
    damageSides: useVersatile ? weapon.versatile!.damageSides : weapon.damageSides,
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
    // Heavy applies to both ranged (DEX<13) and melee (STR<13), so carry it for
    // all weapons; `reach` widens melee reach to 2 tiles.
    heavy:   !!weapon.heavy,
    reach:   !isRanged && !!weapon.reach,
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
    const ac = armor.baseAc + dexBonus + (armor.bonus ?? 0) + (playerDef.fightingStyleDefense ? 1 : 0);
    const catLabel = armor.category.charAt(0).toUpperCase() + armor.category.slice(1);
    armorLabel = `${catLabel} · AC ${ac}`;
  }

  const shieldLabel: string | null = shield ? `+${shield.acBonus} AC` : null;

  let weaponLabel: string | null = null;
  if (weapon) {
    const attack = makePlayerAttack(playerDef, weapon, !!weapon.versatile && !shield);
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

  // The chosen subspecies option (Elf lineage / Tiefling legacy / Dragonborn or
  // Goliath ancestry), if any. Several level-1 effects ride on it: a darkvision
  // override (Drow), a damage resistance (Tiefling legacy), etc.
  const selectedOption: Record<string, unknown> | undefined = (() => {
    if (!playerDef.speciesLineage) return undefined;
    for (const trait of species.traits) {
      const e = trait.effects as Record<string, unknown>;
      const choice = (e.lineageChoice ?? e.ancestryChoice ?? e.legacyChoice) as { options?: Array<Record<string, unknown>> } | undefined;
      const opt = choice?.options?.find((o) => (o.id ?? o.dragon) === playerDef.speciesLineage);
      if (opt) return opt;
    }
    return undefined;
  })();
  const selectedLevel1 = selectedOption?.level1 as Record<string, unknown> | undefined;

  // US-107: seed SRD creature size from the species. A fixed size is a plain
  // string ("Medium"); a choice species (e.g. Human/Tiefling "Small or Medium")
  // is `{ choices }` and has no per-character pick until the creation flow
  // (US-122) — default to the first/larger valid token for now.
  if (typeof species.size === 'string') {
    playerDef.size = parseCreatureSize(species.size);
  } else {
    // Pick the larger option deterministically (independent of authored order).
    playerDef.size = species.size.choices
      .map(parseCreatureSize)
      .reduce((a, b) => (sizeRank(b) > sizeRank(a) ? b : a), 'tiny' as CreatureSize);
  }

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
  // Lineage darkvision override (Elf Drow → 120 ft), authored on the chosen
  // option's level-1 block.
  const dvOverride = (selectedLevel1?.darkvisionOverride as { feet?: number } | undefined)?.feet;
  if (typeof dvOverride === 'number') senses.darkvision = Math.max(senses.darkvision ?? 0, dvOverride);
  if (Object.keys(senses).length > 0) playerDef.senses = senses;

  // US-108: activate the rich-but-previously-inert species origin effects.
  // Purely additive — we only set fields that don't already exist on the
  // player (resistances + origin modifiers), and deliberately do NOT touch
  // the baked `maxHp` / `skills` of pre-built characters (HP bonus is applied
  // at character creation — US-122 — where HP is assembled from scratch, so
  // it can't double-count here).
  const resistances: string[] = [];
  const originModifiers: Modifier[] = [];
  // SRD Dragonborn: Damage Resistance follows the chosen Draconic Ancestry. The
  // `"ancestry"` placeholder resolves to the chosen ancestry's damage type
  // (US-108/US-122). Look up the ancestry option whose `dragon` matches the
  // character's `speciesLineage`.
  const ancestryDamageType = (() => {
    if (!playerDef.speciesLineage) return undefined;
    for (const trait of species.traits) {
      const ac = (trait.effects as { ancestryChoice?: { options?: Array<{ dragon?: string; damageType?: string }> } }).ancestryChoice;
      const opt = ac?.options?.find((o) => o.dragon === playerDef.speciesLineage);
      if (opt?.damageType) return opt.damageType;
    }
    return undefined;
  })();
  for (const trait of species.traits) {
    const e = trait.effects;
    // Damage resistances (Dwarf poison, Tiefling legacy, Dragonborn ancestry).
    // `"ancestry"` resolves to the chosen Draconic Ancestry's damage type.
    for (const dt of e.damageResistance ?? []) {
      const resolved = dt === 'ancestry' ? ancestryDamageType : dt;
      if (resolved && !resistances.includes(resolved)) resistances.push(resolved);
    }
    // Save advantages → typed Modifiers queried via `hasAdvantageOn`. An entry
    // keyed by `ability` ("int") advantages that ability's saves; one keyed by
    // `condition` ("poisoned") advantages saves to avoid/end that condition.
    for (const adv of e.savingThrowAdvantage ?? []) {
      const key = adv.ability ?? adv.condition;
      originModifiers.push(key ? { type: 'advantage', on: 'save', key } : { type: 'advantage', on: 'save' });
    }
  }
  // Subspecies level-1 damage resistance (Tiefling Fiendish Legacy: Abyssal
  // poison / Chthonic necrotic / Infernal fire), authored on the chosen option.
  for (const dt of (selectedLevel1?.damageResistance as string[] | undefined) ?? []) {
    const resolved = dt === 'ancestry' ? ancestryDamageType : dt;
    if (resolved && !resistances.includes(resolved)) resistances.push(resolved);
  }
  if (resistances.length > 0) playerDef.resistances = resistances;
  if (originModifiers.length > 0) playerDef.originModifiers = originModifiers;

  // SRD Halfling Luck: project the species trait onto a flag the player d20
  // roll sites read (`applyHalflingLuck`) without re-scanning species traits.
  if (species.traits.some((t) => t.effects.rerollD20OnesOnTests)) playerDef.halflingLuck = true;

  // SRD Dwarven Toughness: project the per-level HP bonus so the level-up
  // preview can add it without re-scanning species defs. The level-1 portion is
  // applied to `maxHp` at character creation.
  for (const trait of species.traits) {
    const perLevel = trait.effects.hpMaxBonus?.perLevel;
    if (typeof perLevel === 'number' && perLevel > 0) playerDef.hpBonusPerLevel = perLevel;
  }
}

export function applyEquipment(
  playerDef: PlayerDef,
  slots: EquipmentSlots,
  allItems: ItemDef[],
  mageArmor = false,
  shieldSpellActive = false,
  magicWeaponBonus = 0,
  attunedItemIds: string[] = [],
): void {
  const byId = Object.fromEntries(allItems.map((i) => [i.id, i]));
  const armor = slots.armorId ? (byId[slots.armorId] as ArmorDef | undefined) ?? null : null;
  const shield = slots.shieldId ? (byId[slots.shieldId] as ShieldDef | undefined) ?? null : null;
  const weapon = slots.weaponId ? (byId[slots.weaponId] as WeaponDef | undefined) ?? null : null;

  playerDef.ac = computeAC(playerDef, armor, shield, mageArmor, shieldSpellActive, attunedItemIds);
  // SRD Versatile (US-111): two-handed grip when a versatile weapon is held
  // with no shield equipped → larger damage die.
  const twoHandedGrip = !!weapon?.versatile && !shield;
  const base = weapon
    ? makePlayerAttack(playerDef, weapon, twoHandedGrip)
    : { name: 'Unarmed Strike', statKey: 'str' as const, damageDice: 1, damageSides: 1, damageType: 'bludgeoning', savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false, push: false, topple: false };
  // SRD Magic Weapon spell + magic-weapon enhancement bonus (US-124): both are
  // +N to attack and damage rolls. They do NOT stack (both are enhancement
  // bonuses), so take the higher. The bonus rides on the PlayerAttack so the
  // existing CombatSystem resolver consumes it without a separate state lookup.
  const weaponBonus = Math.max(magicWeaponBonus, effectiveItemBonus(weapon, attunedItemIds));
  playerDef.mainAttack = weaponBonus > 0
    ? { ...base, magicWeaponBonus: weaponBonus }
    : base;
}
