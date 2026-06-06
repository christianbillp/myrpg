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
    expect(pd.defaultEquipment.weaponId).toBe('longsword'); // class starting loadout
    expect(pd.defaultFeatureIds).toContain('second-wind');
    expect(pd.spellcastingAbility).toBeUndefined();         // non-caster
    expect(pd.tokenAsset.startsWith('/')).toBe(true);       // client builds `${API_URL}${tokenAsset}`
  });

  it('builds a wizard: caster fields + INT save + a free hand for casting', () => {
    const choices: CharacterCreationChoices = {
      name: 'Test Wizard', speciesId: 'elf', backgroundId: 'sage', classId: 'wizard',
      abilityMethod: 'standard-array',
      baseAbilityScores: arr(8, 14, 13, 15, 12, 10),
      backgroundAbility: { kind: 'two-one', plusTwo: 'int', plusOne: 'con' },
      skillProficiencies: ['arcana', 'investigation'],
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
  });

  it('rejects an over-budget point-buy and a bad skill pick', () => {
    const base: CharacterCreationChoices = {
      name: 'X', speciesId: 'human', backgroundId: 'soldier', classId: 'fighter',
      abilityMethod: 'point-buy', baseAbilityScores: arr(15, 15, 15, 15, 8, 8),
      backgroundAbility: { kind: 'one-one-one' }, skillProficiencies: ['athletics', 'perception'],
    };
    expect(buildPlayerDef(base, defs).ok).toBe(false);  // 15,15,15,15 = 36 > 27
    const badSkill = { ...base, abilityMethod: 'standard-array' as const, baseAbilityScores: arr(15, 14, 13, 12, 10, 8), skillProficiencies: ['arcana', 'stealth'] };
    expect(buildPlayerDef(badSkill, defs).ok).toBe(false);  // arcana not a fighter option
  });
});
