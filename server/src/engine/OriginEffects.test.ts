/**
 * US-108 — origin-effects application pass.
 *
 * Verifies that previously-inert species traits now take effect: damage
 * resistances are seeded onto the player, save advantages surface as queryable
 * modifiers, and the `"ancestry"` placeholder is skipped. The damage-routing
 * math (`playerResistMod`) is exercised through the public resistance lists.
 */
import { describe, it, expect } from 'vitest';
import { applySpecies } from './EquipmentSystem.js';
import { collectModifiers, hasAdvantageOn } from './Modifiers.js';
import type { PlayerDef, SpeciesDef, SpeciesTrait } from './types.js';

function species(traits: SpeciesTrait[]): SpeciesDef {
  return { id: 'sp', name: 'Sp', creatureType: 'Humanoid', size: 'Medium', speed: 30, traits };
}

function player(): PlayerDef {
  return { speciesId: 'sp', speciesLineage: null, speed: 30, featIds: [] } as unknown as PlayerDef;
}

const dwarfResilience: SpeciesTrait = {
  name: 'Dwarven Resilience',
  description: '',
  effects: { damageResistance: ['poison'], savingThrowAdvantage: [{ condition: 'poisoned' }] },
};

describe('applySpecies — origin effects (US-108)', () => {
  it('seeds species damage resistances onto the player', () => {
    const p = player();
    applySpecies(p, [species([dwarfResilience])]);
    expect(p.resistances).toEqual(['poison']);
  });

  it('translates save advantages into queryable origin modifiers', () => {
    const p = player();
    applySpecies(p, [species([dwarfResilience])]);
    // collectModifiers merges originModifiers so hasAdvantageOn sees them.
    p.modifiers = collectModifiers(p, [], []);
    expect(hasAdvantageOn(p, 'save', 'poisoned')).toBe(true);
  });

  it('keys an ability-scoped save advantage by its ability (Gnomish Cunning)', () => {
    const p = player();
    applySpecies(p, [species([{
      name: 'Gnomish Cunning', description: '',
      effects: { savingThrowAdvantage: [{ ability: 'int' }, { ability: 'wis' }, { ability: 'cha' }] },
    }])]);
    p.modifiers = collectModifiers(p, [], []);
    expect(hasAdvantageOn(p, 'save', 'int')).toBe(true);
    expect(hasAdvantageOn(p, 'save', 'wis')).toBe(true);
    expect(hasAdvantageOn(p, 'save', 'str')).toBe(false);
  });

  it('skips the "ancestry" damage-resistance placeholder (needs a creation-time choice)', () => {
    const p = player();
    applySpecies(p, [species([{
      name: 'Draconic Ancestry', description: '',
      effects: { damageResistance: ['ancestry'] },
    }])]);
    expect(p.resistances).toBeUndefined();
  });

  it('leaves resistances/originModifiers unset for a species with no such traits', () => {
    const p = player();
    applySpecies(p, [species([{ name: 'Plain', description: '', effects: {} }])]);
    expect(p.resistances).toBeUndefined();
    expect(p.originModifiers).toBeUndefined();
  });
});
