/**
 * Active species abilities (US-122 species-rule gaps).
 *
 * Orc "Relentless Endurance" contributes a limited-use pool to
 * `player.resources` that is seeded at session build and refilled on a Long
 * Rest, exactly like a class-feature resource. These tests lock in the pure
 * resource derivation and the Long Rest refill path; the drop-to-1 rescue in
 * `GameEngine.applyDamageToPlayer` consumes that pool.
 */
import { describe, it, expect } from 'vitest';
import {
  hasRelentlessEndurance, speciesAbilityResources, RELENTLESS_ENDURANCE_ID,
} from './SpeciesAbilities.js';
import { applyLongRest, buildLongRestPreview, type RestingInputs } from './Resting.js';
import type { PlayerDef, PlayerState, SpeciesDef } from './types.js';

function orc(): SpeciesDef {
  return {
    id: 'orc', name: 'Orc', creatureType: 'humanoid', size: 'medium', speed: 30,
    traits: [
      { name: 'Relentless Endurance', description: '', effects: { relentlessEndurance: { usesPerLongRest: 1 } } },
      { name: 'Darkvision', description: '', effects: { darkvision: { feet: 120 } } },
    ],
  };
}

function elf(): SpeciesDef {
  return {
    id: 'elf', name: 'Elf', creatureType: 'humanoid', size: 'medium', speed: 30,
    traits: [{ name: 'Darkvision', description: '', effects: { darkvision: { feet: 60 } } }],
  };
}

describe('speciesAbilityResources', () => {
  it('seeds the Relentless Endurance pool for an Orc', () => {
    const p = { speciesId: 'orc' } as unknown as PlayerDef;
    expect(speciesAbilityResources(p, [orc(), elf()])).toEqual({ [RELENTLESS_ENDURANCE_ID]: 1 });
    expect(hasRelentlessEndurance(p, [orc(), elf()])).toBe(true);
  });

  it('returns nothing for a species without active abilities', () => {
    const p = { speciesId: 'elf' } as unknown as PlayerDef;
    expect(speciesAbilityResources(p, [orc(), elf()])).toEqual({});
    expect(hasRelentlessEndurance(p, [orc(), elf()])).toBe(false);
  });

  it('returns nothing when the species id is unknown', () => {
    const p = { speciesId: 'gnome' } as unknown as PlayerDef;
    expect(speciesAbilityResources(p, [orc(), elf()])).toEqual({});
  });
});

describe('Long Rest refills species-ability resources', () => {
  it('restores a spent Relentless Endurance use', () => {
    const playerDef = {
      name: 'Grok', level: 1, maxHp: 12, speciesId: 'orc', className: 'Fighter',
      defaultSpellSlots: [], defaultFeatureIds: [],
    } as unknown as PlayerDef;
    const player = {
      hp: 5, hitDiceUsed: 1, spellSlots: [], resources: { [RELENTLESS_ENDURANCE_ID]: 0 },
      exhaustionLevel: 0, tempHp: 0, preparedSpellIds: [],
    } as unknown as PlayerState;
    const inputs: RestingInputs = {
      playerDef, player, features: [], spells: [], classDef: null, species: [orc()],
    };
    const preview = buildLongRestPreview(inputs);
    applyLongRest(inputs, {}, preview);
    expect(player.resources[RELENTLESS_ENDURANCE_ID]).toBe(1);
  });

  it('leaves resources untouched for a non-Orc species', () => {
    const playerDef = {
      name: 'Aria', level: 1, maxHp: 8, speciesId: 'elf', className: 'Wizard',
      defaultSpellSlots: [], defaultFeatureIds: [],
    } as unknown as PlayerDef;
    const player = {
      hp: 8, hitDiceUsed: 0, spellSlots: [], resources: {},
      exhaustionLevel: 0, tempHp: 0, preparedSpellIds: [],
    } as unknown as PlayerState;
    const inputs: RestingInputs = {
      playerDef, player, features: [], spells: [], classDef: null, species: [elf()],
    };
    applyLongRest(inputs, {}, buildLongRestPreview(inputs));
    expect(player.resources[RELENTLESS_ENDURANCE_ID]).toBeUndefined();
  });
});
