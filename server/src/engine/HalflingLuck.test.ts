/**
 * SRD Halfling "Luck" (US-122 species-rule gaps).
 *
 * A natural 1 on any of the player's D20 Tests is rerolled once and the new
 * roll must be used. `applyHalflingLuck` is the shared reroll seam; `applySpecies`
 * projects the species trait onto `PlayerDef.halflingLuck`; `rollSkillCheck`
 * honours it. Randomness is driven by stubbing `Math.random`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyHalflingLuck } from './Dice.js';
import { rollSkillCheck } from './CombatSystem.js';
import { applySpecies } from './EquipmentSystem.js';
import type { PlayerDef, SpeciesDef, SpeciesTrait } from './types.js';

// d(sides) = floor(random * sides) + 1, so random=0 → a natural 1; the value
// `v` (1-20) comes from random = (v - 1) / 20.
function d20Value(v: number): number {
  return (v - 1) / 20 + 1e-9;
}

afterEach(() => vi.restoreAllMocks());

const luckTrait: SpeciesTrait = { name: 'Luck', description: '', effects: { rerollD20OnesOnTests: true } };

function species(traits: SpeciesTrait[]): SpeciesDef {
  return { id: 'halfling', name: 'Halfling', creatureType: 'humanoid', size: 'small', speed: 30, traits };
}

describe('applyHalflingLuck', () => {
  it('rerolls a natural 1 when luck is set and uses the new die', () => {
    vi.spyOn(Math, 'random').mockReturnValue(d20Value(17));
    const r = applyHalflingLuck(1, true, 'd20(1)');
    expect(r.natural).toBe(17);
    expect(r.label).toContain('luck');
  });

  it('leaves a natural 1 alone when luck is not set', () => {
    const r = applyHalflingLuck(1, false, 'd20(1)');
    expect(r.natural).toBe(1);
    expect(r.label).toBe('d20(1)');
  });

  it('never rerolls a non-1 result even with luck', () => {
    const spy = vi.spyOn(Math, 'random');
    const r = applyHalflingLuck(7, true, 'd20(7)');
    expect(r.natural).toBe(7);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('applySpecies — Halfling Luck flag', () => {
  it('sets halflingLuck for a species with the reroll trait', () => {
    const p = { speciesId: 'halfling', speciesLineage: null, speed: 30, featIds: [] } as unknown as PlayerDef;
    applySpecies(p, [species([luckTrait])]);
    expect(p.halflingLuck).toBe(true);
  });

  it('leaves halflingLuck unset for a species without it', () => {
    const p = { speciesId: 'halfling', speciesLineage: null, speed: 30, featIds: [] } as unknown as PlayerDef;
    applySpecies(p, [species([{ name: 'Brave', description: '', effects: {} }])]);
    expect(p.halflingLuck).toBeUndefined();
  });
});

describe('rollSkillCheck honours luck', () => {
  it('rerolls a natural 1 and recomputes success against the new die', () => {
    // First d20 → 1, reroll → 18. With a +0 modifier vs DC 10, the reroll wins.
    const seq = [d20Value(1), d20Value(18)];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => seq[i++] ?? 0.5);
    const r = rollSkillCheck(0, 10, false, false, /*luck*/ true);
    expect(r.roll).toBe(18);
    expect(r.success).toBe(true);
  });
});
