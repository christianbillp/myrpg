/**
 * US-119 — Epic Boon (level 19) choice builder.
 *
 * The class level-19 boon surfaces an `epic-boon-choice` prompt listing every
 * feat in the `epic-boon` category the character doesn't already have; the
 * chosen boon feat is added to `playerDef.featIds` on commit.
 */
import { describe, it, expect } from 'vitest';
import { applyLevelUp } from './Leveling.js';
import type { PlayerDef, FeatDef } from './types.js';
import type { LevelUpPreview } from '../../../shared/types.js';

const BOONS: FeatDef[] = [
  { id: 'boon-of-fate', name: 'Boon of Fate', category: 'epic-boon', description: 'Fate boon.' } as FeatDef,
  { id: 'boon-of-truesight', name: 'Boon of Truesight', category: 'epic-boon', description: 'Truesight boon.' } as FeatDef,
];

function playerDef(): PlayerDef {
  return {
    id: 'p', name: 'Cap', classId: 'fighter', className: 'Fighter', level: 18,
    speciesId: 'human', color: 0, maxHp: 180, ac: 18,
    str: 20, dex: 14, con: 16, int: 10, wis: 12, cha: 10,
    speed: 30, proficiencyBonus: 6, initiativeBonus: 2, passivePerception: 11,
    skills: {}, savingThrows: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    savingThrowProficiencies: [],
    defaultEquipment: { armorId: null, weaponId: null, shieldId: null },
    defaultInventoryIds: [], defaultFeatureIds: [], defaultCantripIds: [],
    defaultSpellbookIds: [], defaultPreparedSpellIds: [], defaultSpellSlots: [],
    tracks: {}, featIds: [],
  } as unknown as PlayerDef;
}

function preview(): LevelUpPreview {
  return {
    fromLevel: 18, toLevel: 19, className: 'Fighter', hpGain: 0,
    proficiencyBefore: 6, proficiencyAfter: 6,
    spellSlotDeltas: [], newFeatures: [{ id: 'epic-boon', name: 'Epic Boon', description: '' }],
    choices: [{
      kind: 'epic-boon-choice', label: 'Epic Boon', description: 'Choose an Epic Boon feat.',
      options: BOONS.map((b) => ({ id: b.id, name: b.name, description: b.description })),
    }],
  } as LevelUpPreview;
}

const REST = { spells: [], classes: [], subclasses: [], features: [] };

describe('Epic Boon choice (US-119)', () => {
  it('adds the chosen boon feat to the character', () => {
    const def = playerDef();
    applyLevelUp({ playerDef: def, choices: { epicBoonChoice: 'boon-of-fate' }, preview: preview(), feats: BOONS, ...REST });
    expect(def.featIds).toContain('boon-of-fate');
    expect(def.defaultFeatureIds).toContain('epic-boon');
  });

  it('rejects a boon not in the offered options', () => {
    const def = playerDef();
    expect(() =>
      applyLevelUp({ playerDef: def, choices: { epicBoonChoice: 'not-a-boon' }, preview: preview(), feats: BOONS, ...REST }),
    ).toThrow();
  });
});
