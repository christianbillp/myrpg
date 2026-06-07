/**
 * US-122 Slice 2 — the PlayerDef builder.
 *
 * Reads the real shipped class/background/species/feat/spell/equipment defs and
 * asserts a built L1 character has correct computed stats: final abilities
 * (base + background increase), HP (hit die + CON + species bonus), baked skill
 * / save maps, L1 features, caster fields, the class starting loadout, and
 * species origin effects (resistances).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildPlayerDef, type CharacterBuilderDefs, type CharacterCreationChoices } from './CharacterBuilder.js';
import { previewForLevel } from './Leveling.js';
import { abilityModifier, type AbilityScores } from '../../../shared/abilityScores.js';

const DATA_DIR = join(import.meta.dirname, '..', '..', 'data');
const readDir = <T>(sub: string): T[] =>
  readdirSync(join(DATA_DIR, sub)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(DATA_DIR, sub, f), 'utf-8')) as T);

function realDefs(): CharacterBuilderDefs {
  return {
    classes: readDir('classes'),
    backgrounds: readDir('backgrounds'),
    species: readDir('species'),
    feats: readDir('feats'),
    features: readDir('features'),
    equipment: readDir('equipment'),
    spells: readDir('spells'),
  };
}

const arr = (str: number, dex: number, con: number, int: number, wis: number, cha: number): AbilityScores =>
  ({ str, dex, con, int, wis, cha });

describe('PlayerDef builder (US-122)', () => {
  const defs = realDefs();

  it('builds a fighter: HP, abilities, saves, skills, starting loadout', () => {
    const choices: CharacterCreationChoices = {
      name: 'Test Fighter', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array',
      baseAbilityScores: arr(15, 13, 14, 8, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['intimidation'], speciesFeat: 'alert',  // Human Skillful + Versatile
      equipmentChoice: 'A',
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pd = r.playerDef;
    expect(pd.str).toBe(17);  // 15 + 2 (background)
    expect(pd.con).toBe(15);  // 14 + 1
    // Fighter d10 + CON mod (+2) = 12 (+ human has no HP bonus).
    expect(pd.maxHp).toBe(10 + abilityModifier(15));
    expect(pd.proficiencyBonus).toBe(2);
    // STR save proficient (fighter), athletics proficient (picked).
    expect(pd.savingThrows.str).toBe(abilityModifier(17) + 2);
    expect(pd.savingThrows.dex).toBe(abilityModifier(13));  // not proficient
    expect(pd.skills.athletics).toBe(abilityModifier(17) + 2);
    expect(pd.skills.arcana).toBe(abilityModifier(8));      // not proficient
    // Class option A (SRD Fighter A): chain mail + greatsword (no shield) + flail + 8 javelins + pack.
    expect(pd.defaultEquipment).toEqual({ armorId: 'chain_mail', weaponId: 'greatsword', shieldId: null });
    expect(pd.defaultInventoryIds.filter((i) => i === 'javelin')).toHaveLength(8);
    expect(pd.defaultInventoryIds).toEqual(expect.arrayContaining(['flail', 'dungeoneers_pack']));
    // Background (Soldier A) package items also land in inventory.
    expect(pd.defaultInventoryIds).toEqual(expect.arrayContaining(['spear', 'healers_kit', 'quiver']));
    // Starting GP = class option (4) + background option (14) = 18 GP → 1800 CP.
    expect(pd.defaultCp).toBe(1800);
    expect(pd.defaultFeatureIds).toContain('second-wind');
    expect(pd.spellcastingAbility).toBeUndefined();         // non-caster
    expect(pd.tokenAsset.startsWith('/')).toBe(true);       // client builds `${API_URL}${tokenAsset}`
  });

  it('honours the class equipment choice (Fighter C = 155 GP, empty slots)', () => {
    const r = buildPlayerDef({
      name: 'Gold Fighter', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 8, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['intimidation'], speciesFeat: 'alert',
      classEquipmentChoice: 'C', equipmentChoice: 'B',  // 155 GP + 50 GP, no items
    }, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.defaultEquipment).toEqual({ armorId: null, weaponId: null, shieldId: null });
    expect(r.playerDef.defaultInventoryIds).toEqual([]);
    expect(r.playerDef.defaultCp).toBe((155 + 50) * 100);
  });

  it('builds a wizard: caster fields + INT save + a free hand for casting', () => {
    const choices: CharacterCreationChoices = {
      name: 'Test Wizard', speciesId: 'elf', backgroundId: 'sage', classId: 'wizard',
      abilityMethod: 'standard-array',
      baseAbilityScores: arr(8, 14, 13, 15, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'int', plusOne: 'con' },
      skillProficiencies: ['arcana', 'investigation'],
      speciesSkills: ['perception'],  // Elf Keen Senses (insight/perception/survival)
      equipmentChoice: 'A',
      cantripIds: ['fire-bolt', 'light', 'ray-of-frost'],
      preparedSpellIds: ['magic-missile', 'shield', 'mage-armor', 'detect-magic'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pd = r.playerDef;
    expect(pd.int).toBe(17);  // 15 + 2
    expect(pd.spellcastingAbility).toBe('int');
    expect(pd.defaultCantripIds).toHaveLength(3);
    expect(pd.defaultPreparedSpellIds).toHaveLength(4);
    expect(pd.defaultSpellbookIds).toEqual(pd.defaultPreparedSpellIds);  // spellbook caster
    expect(pd.defaultSpellSlots).toEqual([2]);
    expect(pd.defaultEquipment.weaponId).toBe('quarterstaff');
  });

  it('applies species origin effects (dwarf poison resistance + HP toughness)', () => {
    const choices: CharacterCreationChoices = {
      name: 'Test Cleric', speciesId: 'dwarf', backgroundId: 'acolyte', classId: 'cleric',
      abilityMethod: 'standard-array',
      baseAbilityScores: arr(13, 10, 14, 8, 15, 12),
      backgroundAbility: { kind: 'two-one', plusTwo: 'wis', plusOne: 'int' },  // acolyte = int/wis/cha
      skillProficiencies: ['medicine', 'persuasion'],
      equipmentChoice: 'A',
      cantripIds: ['sacred-flame', 'light', 'mending'],
      preparedSpellIds: ['cure-wounds', 'guiding-bolt', 'healing-word', 'detect-magic'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const pd = r.playerDef;
    expect(pd.resistances).toContain('poison');  // Dwarven Resilience (applySpecies)
    // Cleric d8 + CON mod(+2) + Dwarven Toughness (+1 at L1) = 11.
    expect(pd.maxHp).toBe(8 + abilityModifier(15) + 1);
    expect(pd.hpBonusPerLevel).toBe(1);  // Dwarven Toughness per-level
  });

  it('adds Dwarven Toughness +1 to each level-up HP gain (vs a non-Dwarf)', () => {
    const base: Omit<CharacterCreationChoices, 'name' | 'speciesId'> = {
      backgroundId: 'acolyte', classId: 'cleric', abilityMethod: 'standard-array',
      baseAbilityScores: arr(13, 10, 14, 8, 15, 12),
      backgroundAbility: { kind: 'two-one', plusTwo: 'wis', plusOne: 'int' },
      skillProficiencies: ['medicine', 'persuasion'],
      equipmentChoice: 'A',
      cantripIds: ['sacred-flame', 'light', 'mending'],
      preparedSpellIds: ['cure-wounds', 'guiding-bolt', 'healing-word', 'detect-magic'],
    };
    const dwarf = buildPlayerDef({ ...base, name: 'D', speciesId: 'dwarf' }, defs);
    const human = buildPlayerDef({ ...base, name: 'H', speciesId: 'human', speciesSkills: ['insight'], speciesFeat: 'alert' }, defs);
    expect(dwarf.ok && human.ok).toBe(true);
    if (!dwarf.ok || !human.ok) return;
    const lv = (pd: typeof dwarf.playerDef) => previewForLevel(pd, 2, defs.features, defs.spells, defs.classes, [], defs.feats).hpGain;
    expect(lv(dwarf.playerDef)).toBe(lv(human.playerDef) + 1);
  });

  it('grants Gnome lineage cantrips (Rock Gnome → Mending + Prestidigitation)', () => {
    const choices: CharacterCreationChoices = {
      name: 'Test Gnome', speciesId: 'gnome', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 10, 12, 8),
      backgroundAbility: { kind: 'two-one', plusTwo: 'con', plusOne: 'str' },  // soldier = str/dex/con
      skillProficiencies: ['athletics', 'perception'],
      speciesLineage: 'rock-gnome',
      equipmentChoice: 'A',
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.defaultCantripIds).toEqual(expect.arrayContaining(['mending', 'prestidigitation']));
    expect(r.playerDef.spellcastingAbility).toBe('int');  // racial default (int/wis/cha)
  });

  it('assigns Common + the two chosen Standard languages', () => {
    const choices: CharacterCreationChoices = {
      name: 'Linguist', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 8, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['intimidation'], speciesFeat: 'alert',  // Human grants
      languages: ['Elvish', 'Dwarvish'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.languages).toEqual(['Common', 'Elvish', 'Dwarvish']);
  });

  it('grants Thieves’ Cant to a rogue (feature grantsLanguages)', () => {
    const choices: CharacterCreationChoices = {
      name: 'Sneak', speciesId: 'halfling', backgroundId: 'criminal', classId: 'rogue',
      abilityMethod: 'standard-array', baseAbilityScores: arr(8, 15, 14, 10, 12, 13),
      backgroundAbility: { kind: 'two-one', plusTwo: 'dex', plusOne: 'con' },
      skillProficiencies: ['stealth', 'acrobatics', 'perception', 'investigation'],  // rogue picks 4
      languages: ['Elvish', 'Goblin'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.languages).toContain('Thieves’ Cant'.replace('’', "'"));  // Thieves' Cant
    expect(r.playerDef.languages).toEqual(expect.arrayContaining(['Common', 'Elvish', 'Goblin', "Thieves' Cant"]));
  });

  it('rejects a non-Standard or wrong-count language pick', () => {
    const base: CharacterCreationChoices = {
      name: 'X', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 14, 13, 12, 10, 8),
      backgroundAbility: { kind: 'one-one-one' }, skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['intimidation'], speciesFeat: 'alert',  // satisfy Human grants so only the language check fails
    };
    expect(buildPlayerDef({ ...base, languages: ['Abyssal', 'Elvish'] }, defs).ok).toBe(false);  // Abyssal is rare
    expect(buildPlayerDef({ ...base, languages: ['Elvish'] }, defs).ok).toBe(false);             // only 1 (needs 2)
    expect(buildPlayerDef({ ...base, languages: ['Common', 'Elvish'] }, defs).ok).toBe(false);   // Common not choosable
  });

  it('grants a Human its Skillful skill + Versatile Origin feat', () => {
    const choices: CharacterCreationChoices = {
      name: 'Versatile Hero', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 8, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['arcana'],   // Skillful: a free skill
      speciesFeat: 'alert',        // Versatile: an Origin feat (no skill grant)
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.skills.arcana).toBe(abilityModifier(r.playerDef.int) + 2);  // now proficient
    expect(r.playerDef.featIds).toContain('alert');
    expect(r.playerDef.featIds.length).toBeGreaterThanOrEqual(2);  // background feat + origin feat
  });

  it('Skilled feat grants 3 extra skill proficiencies (sourced on the Skills page)', () => {
    const choices: CharacterCreationChoices = {
      name: 'Jack of Trades', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 8, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['arcana'],          // Human Skillful (1)
      speciesFeat: 'skilled',             // Versatile → Skilled feat (grants 3)
      featSkills: ['stealth', 'nature', 'medicine'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const sk of ['arcana', 'stealth', 'nature', 'medicine']) {
      const ability = ({ arcana: 'int', stealth: 'dex', nature: 'int', medicine: 'wis' } as const)[sk as 'arcana'];
      expect(r.playerDef.skills[sk]).toBe(abilityModifier(r.playerDef[ability]) + 2);
    }
    // Wrong feat-skill count is rejected.
    expect(buildPlayerDef({ ...choices, featSkills: ['stealth'] }, defs).ok).toBe(false);
  });

  it('rejects a Human with no Origin feat or a non-Origin feat', () => {
    const base: CharacterCreationChoices = {
      name: 'H', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 14, 13, 12, 10, 8),
      backgroundAbility: { kind: 'one-one-one' }, skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['arcana'],
    };
    expect(buildPlayerDef(base, defs).ok).toBe(false);                              // no speciesFeat
    expect(buildPlayerDef({ ...base, speciesFeat: 'great-weapon-fighting' }, defs).ok).toBe(false);  // not an Origin feat
    expect(buildPlayerDef({ ...base, speciesFeat: 'alert' }, defs).ok).toBe(true);  // valid Origin feat
  });

  it('grants species/subspecies cantrips (Tiefling Thaumaturgy + Infernal Fire Bolt) to a non-caster', () => {
    const choices: CharacterCreationChoices = {
      name: 'Hellkin', speciesId: 'tiefling', speciesLineage: 'infernal', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 13, 14, 8, 10, 12),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.defaultCantripIds).toContain('thaumaturgy');  // Otherworldly Presence
    expect(r.playerDef.defaultCantripIds).toContain('fire-bolt');    // Infernal legacy
    expect(r.playerDef.spellcastingAbility).toBeDefined();           // racial casting ability set for the non-caster
  });

  it('merges a Wood Elf racial cantrip into a wizard’s known cantrips and applies +5 speed', () => {
    const choices: CharacterCreationChoices = {
      name: 'Glade', speciesId: 'elf', speciesLineage: 'wood-elf', backgroundId: 'sage', classId: 'wizard',
      abilityMethod: 'standard-array', baseAbilityScores: arr(8, 14, 13, 15, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'int', plusOne: 'con' },
      skillProficiencies: ['arcana', 'investigation'], speciesSkills: ['perception'],
      cantripIds: ['fire-bolt', 'light', 'ray-of-frost'],
      preparedSpellIds: ['magic-missile', 'shield', 'mage-armor', 'detect-magic'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.defaultCantripIds).toEqual(expect.arrayContaining(['fire-bolt', 'light', 'ray-of-frost', 'druidcraft']));
    expect(r.playerDef.speed).toBe(35);  // Elf 30 + Wood Elf +5
  });

  it('resolves Dragonborn ancestry damage resistance (red → fire)', () => {
    const choices: CharacterCreationChoices = {
      name: 'Scaleborn', speciesId: 'dragonborn', speciesLineage: 'red', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'standard-array', baseAbilityScores: arr(15, 12, 14, 8, 10, 13),
      backgroundAbility: { kind: 'two-one', plusTwo: 'str', plusOne: 'con' },
      skillProficiencies: ['athletics', 'perception'],
    };
    const r = buildPlayerDef(choices, defs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playerDef.resistances).toContain('fire');
  });

  it('rejects an over-budget point-buy and a bad skill pick', () => {
    const base: CharacterCreationChoices = {
      name: 'X', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'point-buy', baseAbilityScores: arr(15, 15, 15, 15, 8, 8),
      backgroundAbility: { kind: 'one-one-one' }, skillProficiencies: ['athletics', 'perception'],
      speciesSkills: ['intimidation'], speciesFeat: 'alert',  // satisfy Human grants so only the intended check fails
    };
    expect(buildPlayerDef(base, defs).ok).toBe(false);  // 15,15,15,15 = 36 > 27
    const badSkill = { ...base, abilityMethod: 'standard-array' as const, baseAbilityScores: arr(15, 14, 13, 12, 10, 8), skillProficiencies: ['arcana', 'stealth'] };
    expect(buildPlayerDef(badSkill, defs).ok).toBe(false);  // arcana not a fighter option
  });
});
