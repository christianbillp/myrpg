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
  hasRelentlessEndurance, speciesAbilityResources, speciesFeatureIds, RELENTLESS_ENDURANCE_ID,
} from './SpeciesAbilities.js';
import { doUseFeature } from './FeatureRegistry.js';
import { playerSenses } from './Vision.js';
import { applyLongRest, buildLongRestPreview, type RestingInputs } from './Resting.js';
import { buildTestContext } from '../test/buildTestContext.js';
import type { PlayerDef, PlayerState, SpeciesDef, FeatureDef } from './types.js';

function orc(): SpeciesDef {
  return {
    id: 'orc', name: 'Orc', creatureType: 'humanoid', size: 'medium', speed: 30,
    traits: [
      { name: 'Relentless Endurance', description: '', effects: { relentlessEndurance: { usesPerLongRest: 1 } } },
      { name: 'Adrenaline Rush', description: '', effects: { dashAsBonusAction: true, tempHpOnDash: 'proficiencyBonus' } },
      { name: 'Darkvision', description: '', effects: { darkvision: { feet: 120 } } },
    ],
  };
}

function dwarf(): SpeciesDef {
  return {
    id: 'dwarf', name: 'Dwarf', creatureType: 'humanoid', size: 'medium', speed: 30,
    traits: [
      { name: 'Stonecunning', description: '', effects: { tremorsense: { feet: 60, durationMinutes: 10, usesPerLongRest: 'proficiencyBonus' } } },
      { name: 'Darkvision', description: '', effects: { darkvision: { feet: 120 } } },
    ],
  };
}

const ADRENALINE_RUSH: FeatureDef = {
  id: 'adrenaline-rush', name: 'Adrenaline Rush', classId: 'orc', minLevel: 1, description: '',
  cost: { kind: 'bonus-action' }, resource: { kind: 'uses-per-short-rest', max: 2 }, handler: 'adrenaline-rush',
} as FeatureDef;

function goliath(): SpeciesDef {
  return {
    id: 'goliath', name: 'Goliath', creatureType: 'humanoid', size: 'medium', speed: 35,
    traits: [
      { name: 'Large Form', description: '', effects: { largeForm: { minLevel: 5, durationMinutes: 10, speedBonus: 10, usesPerLongRest: 1 } } },
    ],
  };
}

const STONECUNNING: FeatureDef = {
  id: 'stonecunning', name: 'Stonecunning', classId: 'dwarf', minLevel: 1, description: '',
  cost: { kind: 'bonus-action' }, resource: { kind: 'uses-per-long-rest', max: 2 }, handler: 'stonecunning',
} as FeatureDef;

const LARGE_FORM: FeatureDef = {
  id: 'large-form', name: 'Large Form', classId: 'goliath', minLevel: 5, description: '',
  cost: { kind: 'bonus-action' }, resource: { kind: 'uses-per-long-rest', max: 1 }, handler: 'large-form',
} as FeatureDef;

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

describe('speciesFeatureIds', () => {
  it('grants Adrenaline Rush to an Orc and nothing to an Elf', () => {
    expect(speciesFeatureIds({ speciesId: 'orc', level: 1 } as unknown as PlayerDef, [orc(), elf()])).toEqual(['adrenaline-rush']);
    expect(speciesFeatureIds({ speciesId: 'elf', level: 1 } as unknown as PlayerDef, [orc(), elf()])).toEqual([]);
  });

  it('grants Stonecunning to a Dwarf', () => {
    expect(speciesFeatureIds({ speciesId: 'dwarf', level: 1 } as unknown as PlayerDef, [orc(), dwarf()])).toEqual(['stonecunning']);
  });

  it('gates Large Form behind level 5', () => {
    expect(speciesFeatureIds({ speciesId: 'goliath', level: 4 } as unknown as PlayerDef, [goliath()])).toEqual([]);
    expect(speciesFeatureIds({ speciesId: 'goliath', level: 5 } as unknown as PlayerDef, [goliath()])).toEqual(['large-form']);
  });
});

describe('Adrenaline Rush handler', () => {
  it('Dashes (+speed movement) and grants Temp HP equal to proficiency bonus, spending a bonus action and a use', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { movesLeft: 6, tempHp: 0, resources: { 'adrenaline-rush': 2 } },
      playerDef: { speciesId: 'orc', speed: 30, proficiencyBonus: 2, defaultFeatureIds: ['adrenaline-rush'] },
    });
    ctx.defs.features.push(ADRENALINE_RUSH);
    doUseFeature(ctx, 'adrenaline-rush', {}, []);
    expect(state.player.movesLeft).toBe(12);        // 6 + 30ft/5
    expect(state.player.tempHp).toBe(2);            // = PB
    expect(state.player.conditions).toContain('dashing');
    expect(state.player.bonusActionUsed).toBe(true);
    expect(state.player.resources['adrenaline-rush']).toBe(1);
  });

  it('does not stack Temp HP — keeps the higher pool', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { movesLeft: 6, tempHp: 5, resources: { 'adrenaline-rush': 2 } },
      playerDef: { speciesId: 'orc', speed: 30, proficiencyBonus: 2, defaultFeatureIds: ['adrenaline-rush'] },
    });
    ctx.defs.features.push(ADRENALINE_RUSH);
    doUseFeature(ctx, 'adrenaline-rush', {}, []);
    expect(state.player.tempHp).toBe(5);            // existing 5 > PB 2
  });
});

describe('Stonecunning handler', () => {
  it('grants Tremorsense 60 ft via a buff and surfaces it through playerSenses', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { resources: { stonecunning: 2 } },
      playerDef: { speciesId: 'dwarf', defaultFeatureIds: ['stonecunning'], senses: { darkvision: 120 } },
    });
    ctx.defs.features.push(STONECUNNING);
    doUseFeature(ctx, 'stonecunning', {}, []);
    expect(state.player.buffSenses?.tremorsense).toBe(60);
    expect(state.player.bonusActionUsed).toBe(true);
    expect(state.player.resources['stonecunning']).toBe(1);
    // Vision overlay keeps the static darkvision and adds the buffed tremorsense.
    const senses = playerSenses(ctx);
    expect(senses.darkvision).toBe(120);
    expect(senses.tremorsense).toBe(60);
  });
});

describe('Large Form handler', () => {
  it('turns the Goliath Large and adds +10 ft Speed, spending a use', () => {
    const { ctx, state } = buildTestContext({
      phase: 'player_turn',
      player: { resources: { 'large-form': 1 } },
      playerDef: { speciesId: 'goliath', level: 5, size: 'medium', speed: 35, defaultFeatureIds: ['large-form'] },
    });
    ctx.defs.features.push(LARGE_FORM);
    doUseFeature(ctx, 'large-form', {}, []);
    expect(state.player.buffSize).toBe('large');
    expect(state.player.speedBonus).toBe(10);
    expect(state.player.bonusActionUsed).toBe(true);
    expect(state.player.resources['large-form']).toBe(0);
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

  it('grants Human Resourceful Heroic Inspiration on a Long Rest', () => {
    const playerDef = {
      name: 'Vala', level: 1, maxHp: 10, speciesId: 'human', className: 'Fighter',
      defaultSpellSlots: [], defaultFeatureIds: [],
    } as unknown as PlayerDef;
    const player = {
      hp: 4, hitDiceUsed: 0, spellSlots: [], resources: {}, exhaustionLevel: 0, tempHp: 0,
      heroicInspiration: false, preparedSpellIds: [],
    } as unknown as PlayerState;
    const human: SpeciesDef = {
      id: 'human', name: 'Human', creatureType: 'humanoid', size: 'medium', speed: 30,
      traits: [{ name: 'Resourceful', description: '', effects: { heroicInspirationOnLongRest: true } as never }],
    };
    const inputs: RestingInputs = { playerDef, player, features: [], spells: [], classDef: null, species: [human] };
    applyLongRest(inputs, {}, buildLongRestPreview(inputs));
    expect(player.heroicInspiration).toBe(true);
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
