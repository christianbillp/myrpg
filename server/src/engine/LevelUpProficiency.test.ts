/**
 * US-119 — level-up proficiency-bonus skill bug.
 *
 * When the proficiency bonus rises at a level boundary, the delta must land
 * only on skills the character is actually proficient in (doubled for
 * Expertise), inferred from the pre-baked skill total. The old code shifted
 * EVERY skill uniformly, wrongly crediting the bonus to non-proficient skills.
 */
import { describe, it, expect } from 'vitest';
import { applyLevelUp } from './Leveling.js';
import type { PlayerDef } from './types.js';
import type { LevelUpPreview } from '../../../shared/types.js';

function playerDef(): PlayerDef {
  return {
    id: 'p', name: 'Test', classId: 'rogue', className: 'Rogue', level: 4,
    speciesId: 'human', color: 0, maxHp: 30, ac: 12,
    str: 10, dex: 16, con: 14, int: 12, wis: 10, cha: 10,
    speed: 30, proficiencyBonus: 2, initiativeBonus: 3, passivePerception: 12,
    // Pre-baked totals against PB 2: dex mod +3.
    //  stealth = 3 + 2×2 = 7  (Expertise)
    //  acrobatics = 3 + 2  = 5 (proficient)
    //  arcana = int mod +1 only = 1 (NOT proficient)
    skills: { stealth: 7, acrobatics: 5, arcana: 1 },
    savingThrows: { str: 0, dex: 5, con: 2, int: 3, wis: 0, cha: 0 },
    savingThrowProficiencies: ['dex', 'int'],
    defaultEquipment: { armorId: null, weaponId: null, shieldId: null },
    defaultInventoryIds: [], defaultFeatureIds: [], defaultCantripIds: [],
    defaultSpellbookIds: [], defaultPreparedSpellIds: [], defaultSpellSlots: [],
    tracks: {}, featIds: [],
  } as unknown as PlayerDef;
}

function preview(): LevelUpPreview {
  return {
    fromLevel: 4, toLevel: 5, className: 'Rogue', hpGain: 0,
    proficiencyBefore: 2, proficiencyAfter: 3,
    spellSlotDeltas: [], newFeatures: [], choices: [],
  } as LevelUpPreview;
}

const EMPTY = { features: [], spells: [], classes: [], subclasses: [], feats: [] };

describe('Level-up proficiency-bonus skill shift (US-119)', () => {
  it('shifts proficient skills by the delta, Expertise by double, others not at all', () => {
    const def = playerDef();
    applyLevelUp({ playerDef: def, choices: {} as never, preview: preview(), ...EMPTY });
    expect(def.proficiencyBonus).toBe(3);
    expect(def.skills.acrobatics).toBe(6);  // proficient: 5 + 1
    expect(def.skills.stealth).toBe(9);     // expertise: 7 + 2
    expect(def.skills.arcana).toBe(1);      // not proficient: unchanged
  });

  it('shifts only proficient saving throws (unchanged behaviour)', () => {
    const def = playerDef();
    applyLevelUp({ playerDef: def, choices: {} as never, preview: preview(), ...EMPTY });
    expect(def.savingThrows.dex).toBe(6);   // proficient: 5 + 1
    expect(def.savingThrows.int).toBe(4);   // proficient: 3 + 1
    expect(def.savingThrows.con).toBe(2);   // not proficient: unchanged
  });
});
