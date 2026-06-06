/**
 * Character creation (US-122) — server-side assembly of a complete `PlayerDef`
 * from the player's creation choices.
 *
 * The shared constants + validators (Standard Array, Point Buy, background
 * ability increases) live in `shared/abilityScores.ts`. This module rolls the
 * random scores and assembles the rest: final abilities (base + background
 * increase), max HP (class hit die + CON + species HP bonus), the baked skill /
 * saving-throw maps, L1 class features, caster fields, and the class starting
 * loadout — then runs the same `applySpecies` / `applyModifiers` /
 * `applyEquipment` passes the load path uses, so the result is a ready,
 * fully-derived PlayerDef (speed / size / senses / resistances / AC / mainAttack).
 */
import { d } from './Dice.js';
import { applySpecies, applyEquipment } from './EquipmentSystem.js';
import { applyModifiers } from './Modifiers.js';
import { SKILL_ABILITY } from './Leveling.js';
import {
  featuresAt, cantripsKnownAt, preparedSpellsAt, spellSlotsAt, trackAt,
} from '../../../shared/classProgression.js';
import {
  ABILITY_KEYS, abilityModifier, applyBackgroundAbilityChoice,
  isValidBackgroundAbilityChoice, isValidPointBuy, isStandardArrayAssignment,
  type AbilityScores, type AbilityScoreMethod, type BackgroundAbilityChoice,
} from '../../../shared/abilityScores.js';
import type {
  PlayerDef, ClassDef, BackgroundDef, SpeciesDef, FeatDef, FeatureDef, SpellDef,
  EquipmentDef, PlayerAttack,
} from './types.js';

/** SRD 4d6-drop-lowest: roll four d6, discard the lowest, sum the rest. */
export function rollAbilityScore(): number {
  const rolls = [d(6), d(6), d(6), d(6)].sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3];  // drop rolls[0], the lowest
}

/** Roll a full set of six unassigned ability scores (4d6-drop-lowest each).
 *  The player assigns these to STR/DEX/… in the creator UI. */
export function rollAbilityScoreSet(): number[] {
  return Array.from({ length: 6 }, () => rollAbilityScore());
}

/** Registries the builder consults. A subset of `GameDefs`. */
export interface CharacterBuilderDefs {
  classes: ClassDef[];
  backgrounds: BackgroundDef[];
  species: SpeciesDef[];
  feats: FeatDef[];
  features: FeatureDef[];
  equipment: EquipmentDef[];
  spells: SpellDef[];
}

export interface CharacterCreationChoices {
  name: string;
  speciesId: string;
  speciesLineage?: string | null;
  backgroundId: string;
  classId: string;
  abilityMethod: AbilityScoreMethod;
  /** Assigned scores BEFORE the background increase. */
  baseAbilityScores: AbilityScores;
  backgroundAbility: BackgroundAbilityChoice;
  /** Class skill-proficiency picks (from `class.skillChoices.options`). */
  skillProficiencies: string[];
  /** Background equipment option label (e.g. "A" / "B") — sets starting gold. */
  equipmentChoice?: string;
  /** Caster cantrip picks (count = class cantrips-known at L1). */
  cantripIds?: string[];
  /** Caster prepared/known/spellbook picks (count = class prepared at L1). */
  preparedSpellIds?: string[];
  tokenAsset?: string;
  color?: number;
  shortDescription?: string;
  description?: string;
}

export type BuildResult =
  | { ok: true; playerDef: PlayerDef }
  | { ok: false; error: string };

const ALL_SKILLS = Object.keys(SKILL_ABILITY);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'character';
}

function speciesHpBonusAtL1(species: SpeciesDef): number {
  let bonus = 0;
  for (const trait of species.traits) {
    const hp = trait.effects.hpMaxBonus;
    if (hp) bonus += hp.atLevel1;
  }
  return bonus;
}

const UNARMED: PlayerAttack = {
  name: 'Unarmed Strike', statKey: 'str', damageDice: 1, damageSides: 1, damageType: 'bludgeoning',
  savageAttacker: false, finesse: false, graze: false, vex: false, sap: false, slow: false,
  push: false, topple: false,
} as PlayerAttack;

/**
 * Assemble a complete `PlayerDef` from creation choices, validating the inputs.
 * Returns `{ ok: false, error }` on any invalid choice so the caller (route /
 * UI) can surface the reason without throwing.
 */
export function buildPlayerDef(choices: CharacterCreationChoices, defs: CharacterBuilderDefs): BuildResult {
  const cls = defs.classes.find((c) => c.id === choices.classId);
  if (!cls) return { ok: false, error: `Unknown class "${choices.classId}".` };
  const bg = defs.backgrounds.find((b) => b.id === choices.backgroundId);
  if (!bg) return { ok: false, error: `Unknown background "${choices.backgroundId}".` };
  const species = defs.species.find((s) => s.id === choices.speciesId);
  if (!species) return { ok: false, error: `Unknown species "${choices.speciesId}".` };
  if (!choices.name?.trim()) return { ok: false, error: `A character name is required.` };

  // ── Ability scores ────────────────────────────────────────────────────────
  if (choices.abilityMethod === 'point-buy' && !isValidPointBuy(choices.baseAbilityScores)) {
    return { ok: false, error: `Point Buy spread exceeds the 27-point budget or is out of the 8–15 range.` };
  }
  if (choices.abilityMethod === 'standard-array' && !isStandardArrayAssignment(choices.baseAbilityScores)) {
    return { ok: false, error: `Scores must be an assignment of the Standard Array (15, 14, 13, 12, 10, 8).` };
  }
  const bgAbilities = bg.abilityScores as (typeof ABILITY_KEYS[number])[];
  if (!isValidBackgroundAbilityChoice(choices.backgroundAbility, bgAbilities)) {
    return { ok: false, error: `Invalid background ability increase for "${bg.name}".` };
  }
  const finalScores = applyBackgroundAbilityChoice(choices.baseAbilityScores, choices.backgroundAbility, bgAbilities);

  // ── Skill proficiencies (class picks + background grants) ───────────────────
  const picks = choices.skillProficiencies ?? [];
  const distinctPicks = new Set(picks);
  if (distinctPicks.size !== picks.length) return { ok: false, error: `Duplicate skill proficiency selected.` };
  if (picks.length !== cls.skillChoices.count) {
    return { ok: false, error: `Choose exactly ${cls.skillChoices.count} class skill(s); got ${picks.length}.` };
  }
  for (const sk of picks) {
    if (!cls.skillChoices.options.includes(sk)) return { ok: false, error: `"${sk}" isn't a ${cls.name} skill option.` };
  }
  const proficientSkills = new Set<string>([...picks, ...bg.skillProficiencies]);

  const PB = 2;  // proficiency bonus at level 1
  const skills: Record<string, number> = {};
  for (const sk of ALL_SKILLS) {
    const ability = SKILL_ABILITY[sk]!;
    skills[sk] = abilityModifier(finalScores[ability]) + (proficientSkills.has(sk) ? PB : 0);
  }

  // ── Saving throws (class proficiencies) ─────────────────────────────────────
  const savingThrowProficiencies = [...cls.savingThrows];
  const savingThrows: Record<string, number> = {};
  for (const ab of ABILITY_KEYS) {
    savingThrows[ab] = abilityModifier(finalScores[ab]) + (savingThrowProficiencies.includes(ab) ? PB : 0);
  }

  // ── HP (class hit die max + CON mod + species HP bonus) ──────────────────────
  const maxHp = Math.max(1, cls.hitDie + abilityModifier(finalScores.con) + speciesHpBonusAtL1(species));

  // ── Caster fields ───────────────────────────────────────────────────────────
  const sc = cls.spellcasting;
  let casterFields: Partial<PlayerDef> = {};
  if (sc) {
    const cantripCount = cantripsKnownAt(cls, 1);
    const prepCount = preparedSpellsAt(cls, 1);
    const cantripIds = choices.cantripIds ?? [];
    const prepIds = choices.preparedSpellIds ?? [];
    if (cantripIds.length !== cantripCount) {
      return { ok: false, error: `Choose exactly ${cantripCount} cantrip(s); got ${cantripIds.length}.` };
    }
    if (prepIds.length !== prepCount) {
      return { ok: false, error: `Choose exactly ${prepCount} level-1 spell(s); got ${prepIds.length}.` };
    }
    const spellById = new Map(defs.spells.map((s) => [s.id, s]));
    for (const id of cantripIds) {
      const sp = spellById.get(id);
      if (!sp || sp.level !== 0 || !sp.classes.includes(cls.id)) return { ok: false, error: `"${id}" isn't a ${cls.name} cantrip.` };
    }
    for (const id of prepIds) {
      const sp = spellById.get(id);
      if (!sp || sp.level !== 1 || !sp.classes.includes(cls.id)) return { ok: false, error: `"${id}" isn't a level-1 ${cls.name} spell.` };
    }
    // Trim trailing empty slot levels (L1 casters only have L1 slots) to match
    // the hand-authored character convention (`defaultSpellSlots: [2]`).
    const slotRow = spellSlotsAt(cls, 1) ?? [];
    let lastNonZero = -1;
    for (let i = 0; i < slotRow.length; i++) if (slotRow[i] > 0) lastNonZero = i;
    const slots = slotRow.slice(0, lastNonZero + 1);
    casterFields = {
      spellcastingAbility: sc.ability as PlayerDef['spellcastingAbility'],
      defaultCantripIds: cantripIds,
      defaultPreparedSpellIds: prepIds,
      defaultSpellSlots: slots,
      // A spellbook caster (Wizard) "knows" its prepared list in its spellbook.
      ...(sc.learnModel === 'spellbook' ? { defaultSpellbookIds: [...prepIds] } : {}),
    };
  }

  // ── Equipment + starting gold ───────────────────────────────────────────────
  const eqOption = bg.equipmentOptions.find((o) => o.label === choices.equipmentChoice) ?? bg.equipmentOptions[0];
  const defaultCp = (eqOption?.gold ?? 0) * 100;
  const defaultEquipment = cls.startingEquipment
    ? { ...cls.startingEquipment }
    : { armorId: null, weaponId: null, shieldId: null };

  // ── Background feat ─────────────────────────────────────────────────────────
  const featIds = defs.feats.some((f) => f.id === bg.feat.id) ? [bg.feat.id] : [];

  const sneakAttackDice = (trackAt(cls, 'sneak-attack-dice', 1) as number | undefined) ?? 0;

  const playerDef: PlayerDef = {
    id: slugify(choices.name),
    name: choices.name.trim(),
    speciesName: species.name,
    speciesId: species.id,
    speciesLineage: choices.speciesLineage ?? null,
    className: cls.name,
    backgroundId: bg.id,
    featIds,
    level: 1,
    maxHp,
    ac: 10 + abilityModifier(finalScores.dex),  // recomputed by applyEquipment below
    str: finalScores.str, dex: finalScores.dex, con: finalScores.con,
    int: finalScores.int, wis: finalScores.wis, cha: finalScores.cha,
    proficiencyBonus: PB,
    skills,
    savingThrowProficiencies,
    savingThrows,
    defaultFeatureIds: featuresAt(cls, 1),
    hitDieType: cls.hitDie,
    sneakAttackDice,
    speed: species.speed,  // recomputed by applySpecies below
    color: choices.color ?? 0x88aacc,
    xp: 0,
    savageAttacker: false,
    fightingStyleDefense: false,
    defaultEquipment,
    defaultInventoryIds: [...(cls.startingInventoryIds ?? [])],
    defaultCp,
    mainAttack: { ...UNARMED },  // recomputed by applyEquipment below
    tokenAsset: choices.tokenAsset ?? 'tokens/player_human_wizard.svg',
    shortDescription: choices.shortDescription,
    description: choices.description,
    ...casterFields,
  };

  // Run the same derivation passes the load path uses so the returned PlayerDef
  // is fully resolved (speed / size / senses / resistances / origin modifiers,
  // aggregated modifiers, AC + mainAttack from the equipped loadout).
  applySpecies(playerDef, defs.species);
  applyModifiers(playerDef, defs.feats, defs.features);
  applyEquipment(playerDef, playerDef.defaultEquipment, defs.equipment);

  return { ok: true, playerDef };
}
