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
import { speciesFeatureIds } from './SpeciesAbilities.js';
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
import { mergeLanguages, isStandardLanguage, STANDARD_LANGUAGE_CHOICES } from '../../../shared/languages.js';
import type {
  PlayerDef, ClassDef, BackgroundDef, SpeciesDef, FeatDef, FeatureDef, SpellDef,
  ItemDef, PlayerAttack,
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
  equipment: ItemDef[];
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
  /** Species-granted skill picks (Human "Skillful"). */
  speciesSkills?: string[];
  /** Species-granted Origin feat (Human "Versatile"). */
  speciesFeat?: string;
  /** Skills chosen for feat-granted proficiencies (Skilled feat → 3). */
  featSkills?: string[];
  /** Spellcasting ability for species-granted cantrips, when the species/lineage
   *  offers a choice (Elf/Tiefling: int/wis/cha). Used only for non-casters. */
  racialSpellAbility?: string;
  /** Background equipment option label (e.g. "A" / "B"). */
  equipmentChoice?: string;
  /** Class starting-equipment option label (Fighter "A"/"B"/"C", others "A"/"B").
   *  Defaults to the first option when omitted. */
  classEquipmentChoice?: string;
  /** Caster cantrip picks (count = class cantrips-known at L1). */
  cantripIds?: string[];
  /** Caster prepared/known/spellbook picks (count = class prepared at L1). */
  preparedSpellIds?: string[];
  /** SRD Magic Initiate picks — one entry per feat the character has that grants
   *  the feat (background-granted or Human "Versatile"). `spellList` is pinned by
   *  a background that fixes it (`feat.options.spellList`); otherwise the player
   *  chooses it from the feat's lists. */
  magicInitiate?: Array<{ featId: string; spellList?: string; cantripIds: string[]; spellId: string; ability: string }>;
  tokenAsset?: string;
  color?: number;
  shortDescription?: string;
  description?: string;
  /** The Standard languages chosen at creation (SRD: two beyond Common). */
  languages?: string[];
}

export type BuildResult =
  | { ok: true; playerDef: PlayerDef }
  | { ok: false; error: string };

const ALL_SKILLS = Object.keys(SKILL_ABILITY);

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'character';
}

/** Token paths are consumed client-side as `${API_URL}${path}`, so they must
 *  start with a leading slash; normalise any provided value. */
function normalizeToken(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.startsWith('/') ? path : `/${path}`;
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

  // Species skill grant (Human "Skillful"): validate the count + that each is a
  // real skill, then fold into the proficient set.
  const skillGrant = species.traits.map((t) => t.effects.skillProficiency).find(Boolean);
  const speciesSkills = choices.speciesSkills ?? [];
  if (skillGrant) {
    if (speciesSkills.length !== skillGrant.count) {
      return { ok: false, error: `${species.name} grants ${skillGrant.count} skill(s); got ${speciesSkills.length}.` };
    }
    // `["any"]` = any of the 18 skills; otherwise only the listed choices.
    const allowedSkills = skillGrant.choices.includes('any') ? Object.keys(SKILL_ABILITY) : skillGrant.choices;
    for (const sk of speciesSkills) {
      if (!allowedSkills.includes(sk)) return { ok: false, error: `"${sk}" isn't an allowed ${species.name} skill choice.` };
      proficientSkills.add(sk);
    }
  }

  // ── Feats: background feat + species Origin feat (Human "Versatile") ─────────
  const featIds = defs.feats.some((f) => f.id === bg.feat.id) ? [bg.feat.id] : [];
  const featGrant = species.traits.map((t) => t.effects.originFeat).find(Boolean);
  if (featGrant) {
    const pickedFeat = choices.speciesFeat;
    if (!pickedFeat) return { ok: false, error: `${species.name} grants an Origin feat — choose one.` };
    const feat = defs.feats.find((f) => f.id === pickedFeat);
    if (!feat || feat.category !== 'origin') return { ok: false, error: `"${pickedFeat}" isn't an Origin feat.` };
    if (!featIds.includes(pickedFeat)) featIds.push(pickedFeat);
  }

  // Feat-granted skill proficiencies (Skilled feat → 3 skills). Sum the count
  // across every feat the character has, validate the picks, fold them in.
  const featSkillCount = featIds.reduce((n, fid) => n + (defs.feats.find((f) => f.id === fid)?.effects.skillOrToolProficiencies?.count ?? 0), 0);
  const featSkills = choices.featSkills ?? [];
  if (featSkills.length !== featSkillCount) {
    return { ok: false, error: `Your feats grant ${featSkillCount} skill proficiencies; got ${featSkills.length}.` };
  }
  for (const sk of featSkills) {
    if (!(sk in SKILL_ABILITY)) return { ok: false, error: `"${sk}" isn't a valid skill.` };
    proficientSkills.add(sk);
  }

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

  // ── Equipment + starting gold (SRD: class AND background each grant an
  //    A/B[/C] package — an armor/weapon/shield loadout, inventory items, and
  //    GP; the gold-only option leaves the slots empty). Both contribute. ─────
  const classOption = cls.equipmentOptions?.find((o) => o.label === choices.classEquipmentChoice) ?? cls.equipmentOptions?.[0];
  const bgOption = bg.equipmentOptions.find((o) => o.label === choices.equipmentChoice) ?? bg.equipmentOptions[0];
  const expandItems = (items?: Array<{ itemId?: string; count?: number }>): string[] =>
    (items ?? []).flatMap((it) => (it.itemId ? Array<string>(Math.max(1, it.count ?? 1)).fill(it.itemId) : []));
  const defaultCp = ((classOption?.gold ?? 0) + (bgOption?.gold ?? 0)) * 100;
  const defaultEquipment = {
    armorId: classOption?.armorId ?? null,
    weaponId: classOption?.weaponId ?? null,
    shieldId: classOption?.shieldId ?? null,
  };
  const packageInventoryIds = [...expandItems(classOption?.items), ...expandItems(bgOption?.items)];

  const sneakAttackDice = (trackAt(cls, 'sneak-attack-dice', 1) as number | undefined) ?? 0;

  // ── Languages (US-123) ──────────────────────────────────────────────────────
  // SRD: Common + two chosen Standard languages, plus any feature grants
  // (Rogue Thieves' Cant, Druid Druidic, …). Validate the chosen picks.
  const chosenLangs = choices.languages ?? [];
  const distinctLangs = new Set(chosenLangs);
  if (distinctLangs.size !== chosenLangs.length) return { ok: false, error: `Duplicate language selected.` };
  if (chosenLangs.length > 0 && chosenLangs.length !== STANDARD_LANGUAGE_CHOICES) {
    return { ok: false, error: `Choose exactly ${STANDARD_LANGUAGE_CHOICES} languages; got ${chosenLangs.length}.` };
  }
  for (const lang of chosenLangs) {
    if (lang === 'Common' || !isStandardLanguage(lang)) {
      return { ok: false, error: `"${lang}" isn't a choosable Standard language.` };
    }
  }
  const grantedLangs = featuresAt(cls, 1)
    .flatMap((fid) => defs.features.find((f) => f.id === fid)?.grantsLanguages ?? []);
  const languages = mergeLanguages(chosenLangs, grantedLangs);

  // ── Species / subspecies cantrips (US-108 innate spells, L1) ─────────────────
  // The species base cantrip (Tiefling Otherworldly Presence → Thaumaturgy) plus
  // the selected lineage/legacy's Level-1 cantrip (Wood Elf Druidcraft, Drow
  // Dancing Lights, …). Added to the known cantrips even for non-casters; for a
  // non-caster the racial spellcasting ability makes them castable.
  type SubChoice = { spellcastingAbility?: { choices: string[] }; options?: Array<Record<string, unknown>> };
  const subTrait = species.traits.find((t) => (t.effects as Record<string, unknown>).lineageChoice || (t.effects as Record<string, unknown>).ancestryChoice || (t.effects as Record<string, unknown>).legacyChoice);
  const subChoice = subTrait ? ((subTrait.effects as Record<string, unknown>).lineageChoice ?? (subTrait.effects as Record<string, unknown>).ancestryChoice ?? (subTrait.effects as Record<string, unknown>).legacyChoice) as SubChoice : undefined;
  const subOption = subChoice?.options?.find((o) => (o.id ?? o.dragon) === choices.speciesLineage);
  const baseCantrips = species.traits.map((t) => (t.effects as { cantrip?: string }).cantrip).filter((c): c is string => typeof c === 'string');
  // Subspecies cantrips come in three authored shapes: nested under `level1`
  // (Elf lineages, Tiefling legacies) or directly on the option as `cantrip` /
  // `cantrips` (Gnome Forest = one, Rock = two).
  const subCantripIds = [
    (subOption?.level1 as { cantrip?: string } | undefined)?.cantrip,
    (subOption as { cantrip?: string } | undefined)?.cantrip,
    ...((subOption as { cantrips?: string[] } | undefined)?.cantrips ?? []),
  ].filter((c): c is string => typeof c === 'string');
  const racialCantripIds = [...baseCantrips, ...subCantripIds]
    .filter((id) => defs.spells.some((s) => s.id === id && s.level === 0));
  const racialAbilityChoices = subChoice?.spellcastingAbility?.choices;
  const racialAbility = (choices.racialSpellAbility && racialAbilityChoices?.includes(choices.racialSpellAbility))
    ? choices.racialSpellAbility
    : (racialAbilityChoices?.[0] ?? 'cha');

  // ── Magic Initiate (SRD origin feat) ─────────────────────────────────────────
  // Each granting feat (background-pinned list, or a Versatile pick) adds two
  // cantrips + one always-prepared L1 spell castable once per Long Rest without
  // a slot, and (for a non-caster) a chosen spellcasting ability.
  const mi = applyMagicInitiate(choices, featIds, bg, defs);
  if (!mi.ok) return mi;

  const allCantrips = [...new Set([...(casterFields.defaultCantripIds ?? []), ...racialCantripIds, ...mi.cantripIds])];
  const spellcastingAbility = (casterFields.spellcastingAbility
    ?? (racialCantripIds.length ? racialAbility as PlayerDef['spellcastingAbility'] : undefined)
    ?? (mi.spellIds.length ? mi.ability as PlayerDef['spellcastingAbility'] : undefined));

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
    languages,
    savageAttacker: false,
    fightingStyleDefense: false,
    defaultEquipment,
    defaultInventoryIds: packageInventoryIds,
    defaultCp,
    mainAttack: { ...UNARMED },  // recomputed by applyEquipment below
    tokenAsset: normalizeToken(choices.tokenAsset) ?? '/tokens/player_human_wizard.svg',
    shortDescription: choices.shortDescription,
    description: choices.description,
    ...casterFields,
    // Merge racial + Magic Initiate cantrips into the known list and ensure a
    // spellcasting ability exists for a non-caster who gained one (override the
    // casterFields spread). The Magic Initiate L1 spell is tracked separately in
    // `magicInitiateSpellIds` (always prepared + free-cast), not in the class
    // prepared/spellbook lists.
    ...(allCantrips.length ? { defaultCantripIds: allCantrips } : {}),
    ...(spellcastingAbility ? { spellcastingAbility } : {}),
    ...(mi.spellIds.length ? { magicInitiateSpellIds: mi.spellIds } : {}),
  };

  // Run the same derivation passes the load path uses so the returned PlayerDef
  // is fully resolved (speed / size / senses / resistances / origin modifiers,
  // aggregated modifiers, AC + mainAttack from the equipped loadout).
  applySpecies(playerDef, defs.species);
  // Surface activated species abilities (Orc Adrenaline Rush, …) as known
  // features so they get a player action button like class features.
  for (const fid of speciesFeatureIds(playerDef, defs.species)) {
    if (!playerDef.defaultFeatureIds?.includes(fid)) (playerDef.defaultFeatureIds ??= []).push(fid);
  }
  applyModifiers(playerDef, defs.feats, defs.features);
  applyEquipment(playerDef, playerDef.defaultEquipment, defs.equipment);

  return { ok: true, playerDef };
}

type MagicInitiateResult =
  | { ok: true; cantripIds: string[]; spellIds: string[]; ability: string }
  | { ok: false; error: string };

/** Resolve the SRD Magic Initiate picks for every feat the character has that
 *  grants the feat. A feat is "Magic Initiate-style" when its effects carry both
 *  `learnedCantrips` and `preparedSpell`. The spell list is pinned when the
 *  granting background fixes it (`feat.options.spellList`); otherwise the player
 *  chose it. Validates the cantrip/spell picks against that list and the SRD
 *  counts. */
function applyMagicInitiate(
  choices: CharacterCreationChoices,
  featIds: string[],
  bg: BackgroundDef,
  defs: CharacterBuilderDefs,
): MagicInitiateResult {
  const cantripIds: string[] = [];
  const spellIds: string[] = [];
  let ability = '';
  const spellById = new Map(defs.spells.map((s) => [s.id, s]));

  for (const fid of featIds) {
    const feat = defs.feats.find((f) => f.id === fid);
    const learned = feat?.effects.learnedCantrips;
    const prepared = feat?.effects.preparedSpell;
    if (!feat || !learned || !prepared) continue;  // not a Magic Initiate-style feat

    const pinned = fid === bg.feat.id ? (bg.feat.options as { spellList?: string } | null)?.spellList : undefined;
    const choice = choices.magicInitiate?.find((m) => m.featId === fid);
    const list = pinned ?? choice?.spellList;
    if (!list || !learned.lists.includes(list)) {
      return { ok: false, error: `${feat.name}: choose a spell list (${learned.lists.join(', ')}).` };
    }
    if (!choice) return { ok: false, error: `${feat.name}: choose ${learned.count} cantrips and a level-${prepared.level} spell.` };

    if (choice.cantripIds.length !== learned.count) {
      return { ok: false, error: `${feat.name}: choose exactly ${learned.count} cantrips; got ${choice.cantripIds.length}.` };
    }
    for (const id of choice.cantripIds) {
      const sp = spellById.get(id);
      if (!sp || sp.level !== 0 || !sp.classes.includes(list)) return { ok: false, error: `${feat.name}: "${id}" isn't a ${list} cantrip.` };
    }
    const spell = spellById.get(choice.spellId);
    if (!spell || spell.level !== prepared.level || !spell.classes.includes(list)) {
      return { ok: false, error: `${feat.name}: "${choice.spellId}" isn't a level-${prepared.level} ${list} spell.` };
    }

    const abilityChoices = feat.effects.spellcastingAbility?.choices ?? ['int', 'wis', 'cha'];
    cantripIds.push(...choice.cantripIds);
    spellIds.push(choice.spellId);
    ability = ability || (abilityChoices.includes(choice.ability) ? choice.ability : abilityChoices[0]);
  }

  return { ok: true, cantripIds, spellIds, ability };
}
