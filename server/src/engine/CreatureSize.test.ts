/**
 * US-107 — creature size as a first-class field.
 *
 * Covers the monster `type`-string parser (`parseCreatureSize`), the
 * size-rank ordering used by the Grapple/Shove one-size gate, and the
 * player-side seeding from species (`applySpecies`), including the
 * choice-species "pick the larger" rule.
 */
import { describe, it, expect } from 'vitest';
import { parseCreatureSize, sizeRank, type CreatureSize } from '../../../shared/types.js';
import { applySpecies } from './EquipmentSystem.js';
import type { PlayerDef, SpeciesDef } from './types.js';

describe('parseCreatureSize', () => {
  it('reads the leading size token from a monster type string', () => {
    expect(parseCreatureSize('Medium Humanoid')).toBe('medium');
    expect(parseCreatureSize('Tiny Construct, Unaligned')).toBe('tiny');
    expect(parseCreatureSize('Small Fey (Goblinoid), Chaotic Neutral')).toBe('small');
    expect(parseCreatureSize('Gargantuan Dragon')).toBe('gargantuan');
  });

  it('picks the first (larger) listed size for a disjunction', () => {
    expect(parseCreatureSize('Medium or Small Humanoid, Neutral')).toBe('medium');
  });

  it('defaults to medium when no size token is present or input is empty', () => {
    expect(parseCreatureSize('Humanoid, Neutral')).toBe('medium');
    expect(parseCreatureSize('')).toBe('medium');
    expect(parseCreatureSize(null)).toBe('medium');
    expect(parseCreatureSize(undefined)).toBe('medium');
  });
});

describe('sizeRank', () => {
  it('orders sizes smallest to largest', () => {
    const order: CreatureSize[] = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'];
    for (let i = 1; i < order.length; i++) {
      expect(sizeRank(order[i])).toBeGreaterThan(sizeRank(order[i - 1]));
    }
  });

  it('gives a one-size difference for the Grapple/Shove gate', () => {
    expect(sizeRank('large') - sizeRank('medium')).toBe(1);
    expect(sizeRank('huge') - sizeRank('medium')).toBe(2);
  });
});

function bareSpecies(size: SpeciesDef['size']): SpeciesDef {
  return { id: 'test', name: 'Test', creatureType: 'Humanoid', size, speed: 30, traits: [] };
}

function barePlayer(): PlayerDef {
  // Only the fields applySpecies touches need to be real.
  return { speciesId: 'test', speciesLineage: null, speed: 30 } as unknown as PlayerDef;
}

describe('applySpecies — size seeding (US-107)', () => {
  it('seeds a fixed species size onto the player', () => {
    const p = barePlayer();
    applySpecies(p, [bareSpecies('Small')]);
    expect(p.size).toBe('small');
  });

  it('picks the larger option for a choice species regardless of order', () => {
    const p = barePlayer();
    applySpecies(p, [bareSpecies({ choices: ['Small', 'Medium'] })]);
    expect(p.size).toBe('medium');

    const p2 = barePlayer();
    applySpecies(p2, [bareSpecies({ choices: ['Medium', 'Small'] })]);
    expect(p2.size).toBe('medium');
  });

  it('leaves size unset when the species is unknown', () => {
    const p = barePlayer();
    applySpecies(p, []);
    expect(p.size).toBeUndefined();
  });
});
